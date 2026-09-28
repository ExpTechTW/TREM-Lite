/**
 * A downloaded update, waiting for a restart (desktop). The updater (Rust,
 * updater.rs) downloads in the background and installs at the next launch;
 * this tells the user one is ready — the note above the clock, TimeBar.tsx —
 * and, with 設定 → 自動重新啟動以完成更新 on (the default), restarts for it
 * once nothing is going on: no EEW, no station alert, no intensity report on
 * the map, no replay, and no event for QUIET_MS. Tauri's updater leaves when
 * to restart to the app; an earthquake is never the moment.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { isMainHidden } from "@/features/window/window";
import { getConfig } from "@/lib/config";
import { inTauri } from "@/lib/env";
import { events } from "@/lib/events";
import { createLogger, fmtDur } from "@/lib/logger";
import { realNow } from "@/lib/ntp";
import { variable } from "@/lib/variable";
import { ui } from "@/lib/variable.ui";
import { versionLabel } from "@/lib/version";

/** How long after the last event the app must stay quiet before it restarts. */
const QUIET_MS = 5 * 60 * 1000;
const CHECK_MS = 10_000;

const log = createLogger("update");

let lastEvent = 0;
let waiting: ReturnType<typeof setInterval> | null = null;

function quiet(): boolean {
  return (
    variable.play_mode === 0 &&
    !variable.data.eew.length &&
    !variable.cache.rts_alert &&
    !variable.cache.show_intensity &&
    !variable.cache.show_lpgm &&
    realNow() - lastEvent > QUIET_MS
  );
}

/** Restart now to install the update. */
export function restartForUpdate(): void {
  void invoke("update_restart", { hidden: isMainHidden() });
}

function staged(version: string): void {
  ui.updateReady = versionLabel(version);
  events.emit("UpdateReady", ui.updateReady);
  const auto = getConfig()["check-box"]["update-auto-restart"];
  log.info(
    auto
      ? `更新 ${ui.updateReady} 等待重新啟動：沒有預警、測站警報、震度速報、重播，且 ${fmtDur(QUIET_MS)} 沒有新事件時自動重啟`
      : `更新 ${ui.updateReady} 等待重新啟動：自動重啟已關閉，等使用者按`,
  );
  waiting ??= setInterval(() => {
    if (getConfig()["check-box"]["update-auto-restart"] && quiet()) {
      log.info(`已安靜 ${fmtDur(realNow() - lastEvent)}，自動重新啟動以完成更新 ${ui.updateReady}`);
      restartForUpdate();
    }
  }, CHECK_MS);
}

export function initUpdate(): void {
  if (!inTauri) return;
  for (const name of ["EewRelease", "EewUpdate", "RtsShindo0", "IntensityRelease", "ReportRelease"] as const) {
    events.on(name, () => {
      lastEvent = realNow();
    });
  }
  void listen<string>("update-staged", (e) => staged(e.payload));
  void invoke<string | null>("update_pending")
    .then((version) => version && staged(version))
    .catch(() => {});
}
