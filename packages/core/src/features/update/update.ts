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
import { realNow } from "@/lib/ntp";
import { variable } from "@/lib/variable";
import { ui } from "@/lib/variable.ui";
import { versionLabel } from "@/lib/version";

/** How long after the last event the app must stay quiet before it restarts. */
const QUIET_MS = 5 * 60 * 1000;
const CHECK_MS = 10_000;

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
  waiting ??= setInterval(() => {
    if (getConfig()["check-box"]["update-auto-restart"] && quiet()) restartForUpdate();
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
