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
    // Enabled is rewritten on every launch, not only when missing: the login
    // item records the path the app ran from, and `isEnabled` only asks
    // whether one exists. An install that moved — the per-machine MSI replaced
    // by the per-user installer, an AppImage downloaded anew — would otherwise
    // keep a login item that starts nothing.
    if (getConfig()["check-box"]["other-auto-start"]) await enableAutostart();
    else if (await isAutostartEnabled()) await disableAutostart();
  })().catch(() => {
    /* Unsupported login-item services must not block monitoring startup. */
  });
}
