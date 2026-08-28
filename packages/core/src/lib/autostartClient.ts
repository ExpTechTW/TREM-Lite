import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";

import { getConfig } from "./config";
import { inTauri } from "./env";

let initialized = false;

/** Keep the OS login item aligned with the persisted application preference. */
export function initAutostart(): void {
  if (initialized) return;
  initialized = true;
  if (!inTauri) return;

  void (async () => {
    const desired = !!getConfig()["check-box"]["other-auto-start"];
    const actual = await isAutostartEnabled();
    if (desired === actual) return;
    if (desired) await enableAutostart();
    else await disableAutostart();
  })().catch(() => {
    /* Unsupported login-item services must not block monitoring startup. */
  });
}
