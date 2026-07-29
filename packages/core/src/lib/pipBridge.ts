/**
 * Main-window → PiP-window bridge. The PiP is a separate webview with its own JS
 * context, so it can't read `ui` directly; we emit the current EEW to it via a
 * Tauri event (replaces the old ipcRenderer 'update-pip').
 */
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

import { ui } from "./variable.ui";

let last = "";

export function initPipBridge(): void {
  setInterval(() => {
    const payload = ui.currentEew
      ? { noEew: false, ...ui.currentEew }
      : { noEew: true };
    const s = JSON.stringify(payload);
    if (s === last) return;
    last = s;
    void emit("update-pip-content", payload);
    // Hide the PiP when there is no active EEW.
    if (!ui.currentEew) void invoke("pip_hide").catch(() => {});
  }, 500);
}
