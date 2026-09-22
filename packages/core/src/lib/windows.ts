/** Create/focus the secondary Tauri windows (settings, pip). */
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { BackgroundThrottlingPolicy } from "@tauri-apps/api/window";
import { inTauri } from "./env";

// Legacy main.js used `transparent: is_mac ? false : true` for the settings window
// (macOS renders it opaque to avoid the transparent-decorationless corner artifact).
const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
let pipWindowPromise: Promise<WebviewWindow> | null = null;

export async function openSettings(): Promise<void> {
  if (!inTauri) return;
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

async function createPipWindow(): Promise<WebviewWindow> {
  const existing = await WebviewWindow.getByLabel("pip");
  if (existing) return existing;

  const created = new WebviewWindow("pip", {
    url: "pip.html",
    width: 276,
    height: 147,
    minWidth: 276,
    maxWidth: 276,
    minHeight: 147,
    maxHeight: 147,
    x: 0,
    y: 0,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    visibleOnAllWorkspaces: true,
    skipTaskbar: true,
    maximizable: false,
    // Tauri has no cross-platform setAspectRatio equivalent. Fixing the legacy
    // 276×147 shape prevents a freely resizable window from stretching/cropping
    // the shared EEW renderer.
    resizable: false,
    visible: false,
    // It renders an alert while still hidden and is shown once that is done
    // (see pipBridge). WKWebView's default is to suspend a web view that is
    // not on screen, which would stall exactly that render. The main window
    // opts out the same way, in tauri.conf.json.
    backgroundThrottling: "disabled" as BackgroundThrottlingPolicy,
  });

  return new Promise<WebviewWindow>((resolve, reject) => {
    let settled = false;
    const finish = (result: { window?: WebviewWindow; error?: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (result.window) resolve(result.window);
      else reject(result.error instanceof Error ? result.error : new Error(String(result.error)));
    };
    const timeout = window.setTimeout(() => {
      void WebviewWindow.getByLabel("pip")
        .then((window) => finish(window ? { window } : { error: "PiP window creation timed out" }))
        .catch((error) => finish({ error }));
    }, 5000);

    void created.once("tauri://created", () => finish({ window: created })).catch((error) =>
      finish({ error }),
    );
    void created.once<unknown>("tauri://error", (event) => finish({ error: event.payload })).catch(
      (error) => finish({ error }),
    );
  });
}

export async function ensurePipWindow(): Promise<WebviewWindow> {
  if (!inTauri) throw new Error("PiP is only available in the desktop app");
  if (!pipWindowPromise) pipWindowPromise = createPipWindow();
  try {
    return await pipWindowPromise;
  } finally {
    pipWindowPromise = null;
  }
}
