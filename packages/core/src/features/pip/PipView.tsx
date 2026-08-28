import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ExternalLink, X } from "lucide-react";

import type { PipPayload } from "@/lib/pipBridge";
import { inTauri } from "@/lib/env";
import type { EewDisplay, RtsTriggerDisplay } from "@/lib/variable.ui";
import { EewPanel } from "@/overlays/EewInfoBox";

/** Compact always-on-top window using the exact same EEW renderer as main. */
export function PipView() {
  const [data, setData] = useState<PipPayload>(() => previewPayload());

  useEffect(() => {
    if (!inTauri) return;
    const listeners = Promise.all([
      listen<PipPayload>("update-pip-content", (event) => setData(event.payload)),
      listen("pip-sync-request", () => void emit("pip-ready")),
    ]);
    void listeners.then(() => emit("pip-ready"));
    return () => {
      void listeners.then((unlisten) => unlisten.forEach((fn) => fn()));
    };
  }, []);

  // React effects run after the payload has committed to the PiP DOM. The main
  // window waits for this acknowledgement before revealing PiP, preventing a
  // one-frame flash of idle or stale alert content.
  useEffect(() => {
    if (inTauri && data.revision) void emit("pip-rendered", { revision: data.revision });
  }, [data]);

  let eew: EewDisplay | null = null;
  let trigger: RtsTriggerDisplay | null = null;
  if (!data.noEew) {
    if ("trigger" in data) trigger = data.trigger;
    else eew = data;
  }

  return (
    <div data-tauri-drag-region="deep" className="legacy-pip-shell h-screen w-screen overflow-hidden">
      <EewPanel eew={eew} trigger={trigger} variant="pip" />
      <div className="legacy-pip-controls">
        <button type="button" title="返回主視窗" onClick={() => {
          if (!inTauri) return;
          void invoke("window_focus").catch(() => {});
          void getCurrentWindow().hide().catch(() => {});
        }}>
          <ExternalLink />
        </button>
        <button type="button" title="關閉子母畫面" onClick={() => {
          if (inTauri) void getCurrentWindow().hide().catch(() => {});
        }}>
          <X />
        </button>
      </div>
    </div>
  );
}

/** Browser-only visual fixture; the desktop window still receives real Tauri events. */
function previewPayload(): PipPayload {
  if (inTauri) return { noEew: true };
  const state = new URLSearchParams(window.location.search).get("state");
  if (state === "trigger") {
    return {
      noEew: false,
      trigger: {
        max: 4,
        locations: [
          { i: 4, name: "花蓮縣秀林鄉" },
          { i: 4, name: "花蓮縣壽豐鄉" },
          { i: 3, name: "宜蘭縣南澳鄉" },
          { i: 3, name: "臺東縣海端鄉" },
        ],
      },
    };
  }
  if (state === "eew" || state === "cancel") {
    return {
      noEew: false,
      id: "preview-eew",
      statusClass: state === "cancel" ? "eew-cancel" : "eew-alert",
      serial: 3,
      final: false,
      unitText: "CWA",
      loc: "花蓮縣近海",
      depth: 18,
      mag: 5.8,
      max: 6,
      nsspe: false,
      time: new Date("2026-08-28T07:25:29+08:00").getTime(),
    };
  }
  return { noEew: true };
}
