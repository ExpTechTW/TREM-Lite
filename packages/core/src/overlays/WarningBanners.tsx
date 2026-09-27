import { useState } from "react";
import { AlertTriangle, KeyRound, WifiOff } from "lucide-react";

import { getConfig, writeConfig } from "@/lib/config";
import { inTauri } from "@/lib/env";
import { ui } from "@/lib/variable.ui";
import { openSettings } from "@/lib/windows";
import { useRerenderOn } from "@/hooks/useTremEvent";

/**
 * Top-right warning banners (ports warning-message-box): no-internet,
 * unstable, and the realtime station stream lacking a usable API token.
 */
export function WarningBanners() {
  useRerenderOn("DataRts", "InternetErrorChange", "RtsAccessChange");
  const access = ui.rtsAccess;
  if (!ui.internetError && !ui.unstable && access.state === "ok") return null;

  return (
    <div className="legacy-warning-banners pointer-events-none absolute right-[315px] top-[30px] z-40 flex flex-col items-center gap-[5px] p-[5px] text-[15px]">
      {access.state !== "ok" && (
        <Banner
          icon={<KeyRound className="h-[25px] w-[25px]" />}
          title={access.state === "missing" ? "需要 API 權杖" : "API 權杖無法使用"}
          lines={
            access.state === "missing"
              ? ["即時測站資料需要", "ExpTech API 權杖"]
              : [access.reason, "請更新 API 權杖"]
          }
          tone="warn"
        >
          <TokenAction />
        </Banner>
      )}
      {ui.internetError && (
        <Banner
          icon={<WifiOff className="h-[25px] w-[25px]" />}
          title="網路異常"
          lines={["網路連線異常", "請待稍後重試"]}
          tone="error"
        />
      )}
      {ui.unstable && (
        <Banner
          icon={<AlertTriangle className="h-[25px] w-[25px]" />}
          title="不穩定"
          lines={["受地震活動的影響", "觀測點可能不穩定"]}
          tone="warn"
        />
      )}
    </div>
  );
}

/**
 * Where to put a token. The desktop app has a settings window for it; the web
 * build has none, so the token is entered here. Saving is enough: the data
 * loop sees the new token and reopens the stream with it.
 */
function TokenAction() {
  const [token, setToken] = useState("");
  const button = "rounded-[3px] px-2 py-[2px] text-[13px] font-bold";
  const buttonStyle = { backgroundColor: "var(--rts-trigger-middle)", color: "#000" };

  if (inTauri) {
    return (
      <button type="button" className={`${button} pointer-events-auto self-start`} style={buttonStyle} onClick={() => void openSettings()}>
        前往設定
      </button>
    );
  }

  const save = () => {
    const value = token.trim();
    if (!value) return;
    void writeConfig({ ...getConfig(), apiToken: value });
    setToken("");
  };
  return (
    <form
      className="pointer-events-auto flex gap-[5px]"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <input
        type="password"
        value={token}
        placeholder="et_…"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setToken(event.target.value)}
        className="w-[110px] rounded-[3px] border border-white/20 bg-black/40 px-1.5 py-[2px] text-[13px] text-white outline-none"
      />
      <button type="submit" className={button} style={buttonStyle}>
        儲存
      </button>
    </form>
  );
}

function Banner({
  icon,
  title,
  lines,
  tone,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  lines: string[];
  tone: "error" | "warn";
  children?: React.ReactNode;
}) {
  const accent = tone === "warn" ? "var(--rts-trigger-middle)" : "var(--rts-trigger-high)";
  return (
    <div
      className="min-w-[160px] rounded-[5px] border-2"
      style={{ backgroundColor: "var(--panel-bg)", borderColor: "#000000ab" }}
    >
      <div
        className="flex flex-col gap-[3px] rounded-[5px] px-2.5 py-[5px]"
        style={{ backgroundColor: "#000000ab" }}
      >
        <div className="flex items-center gap-2 font-bold" style={{ color: accent }}>
          {icon}
          <span>{title}</span>
        </div>
        <div className="flex flex-col text-[14px]" style={{ color: "var(--light)" }}>
          {lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
        {children}
      </div>
    </div>
  );
}
