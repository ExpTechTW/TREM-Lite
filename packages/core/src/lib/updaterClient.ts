/** Packaged-app OTA scheduler matching the legacy five-minute cadence. */
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

import { getConfig } from "./config";
import { inTauri } from "./env";
import { createLogger } from "./logger";
import { sendDesktopNotification } from "./notificationClient";

const log = createLogger("updater");
let initialized = false;
let checking = false;

async function checkAndInstall(): Promise<void> {
  if (checking || !getConfig()["check-box"]["ota-auto-update"]) return;
  checking = true;
  try {
    const update = await check();
    if (!update) return;
    await sendDesktopNotification(
      `TREM Lite ${update.version} 可用`,
      "已開始下載更新，完成後會先通知再重新啟動。",
    );
    await update.downloadAndInstall();
    await sendDesktopNotification(
      "TREM Lite 更新已安裝",
      "程式將在 3 秒後重新啟動。",
    );
    window.setTimeout(() => void relaunch(), 3000);
  } catch (error) {
    log.debug("automatic check skipped", error);
  } finally {
    checking = false;
  }
}

export function initUpdater(): void {
  if (initialized) return;
  initialized = true;
  // The legacy scheduler deliberately did not run in development builds.
  if (!inTauri || !import.meta.env.PROD) return;
  void checkAndInstall();
  window.setInterval(() => void checkAndInstall(), 300000);
}
