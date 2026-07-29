/** Create/focus the secondary Tauri windows (settings, pip). */
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";

// Legacy main.js used `transparent: is_mac ? false : true` for the settings window
// (macOS renders it opaque to avoid the transparent-decorationless corner artifact).
const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

export async function openSettings(): Promise<void> {
  const existing = await WebviewWindow.getByLabel("settings");
  if (existing) {
    await existing.show();
    await existing.setFocus();
    return;
  }
  new WebviewWindow("settings", {
    url: "settings.html",
    title: "TREM-Lite 設定",
    width: 970,
    height: 590,
    resizable: false,
    decorations: false,
    transparent: !isMac,
  });
}

export async function ensurePipWindow(): Promise<WebviewWindow> {
  const existing = await WebviewWindow.getByLabel("pip");
  if (existing) return existing;
  return new WebviewWindow("pip", {
    url: "pip.html",
    width: 276,
    height: 147,
    minWidth: 276,
    maxWidth: 400,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    visible: false,
  });
}

export async function togglePip(): Promise<void> {
  await ensurePipWindow();
  await invoke("pip_show");
}
