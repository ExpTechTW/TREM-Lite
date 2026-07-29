/**
 * Config client — talks to the Rust YAML config store (config.rs).
 * Replaces legacy/src/js/core/config.js (electron-store/YAML + IPC).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { inTauri } from "./env";
import type { TremConfig } from "./types";

/** Mirrors src-tauri/default.yml — used as the browser-mode / fallback config. */
export const DEFAULT_CONFIG: TremConfig = {
  ver: 5,
  "location-code": 711,
  "realtime-station-id": 6732340,
  "alert-level": { "rts-intensity": 0, "eew-intensity": 0 },
  "check-box": {
    "show-window-eew": true,
    "show-window-report": true,
    "show-window-detect": true,
    "show-window-rts-intensity": true,
    "early-warning-trem-eew": false,
    "other-auto-start": true,
    "other-tts": true,
    "ota-auto-update": true,
    "graphics-block-auto-zoom": false,
    "graphics-show-fault": false,
    "sound-effects-dong": true,
    "sound-effects-EEW": true,
    "sound-effects-EEW2": true,
    "sound-effects-PAlert": true,
    "sound-effects-PGA1": true,
    "sound-effects-PGA2": true,
    "sound-effects-Report": true,
    "sound-effects-Shindo0": true,
    "sound-effects-Shindo1": true,
    "sound-effects-Shindo2": true,
    "sound-effects-Update": true,
  },
  apiProxyDomain: "api.lb.exptech.dev",
};

let cache: TremConfig | null = null;

/** Load (and cache) the full config. */
export async function loadConfig(force = false): Promise<TremConfig> {
  if (cache && !force) return cache;
  // Browser mode (headless WebKit debugging): no Rust backend — use defaults.
  if (!inTauri) {
    cache = DEFAULT_CONFIG;
    return cache;
  }
  cache = await invoke<TremConfig>("config_get");
  return cache;
}

/** Synchronous access to the last-loaded config (falls back to defaults). */
export function getConfig(): TremConfig {
  if (!cache) cache = DEFAULT_CONFIG;
  return cache;
}

/** Persist the whole config. Broadcasts `config-updated` from Rust. */
export async function writeConfig(config: TremConfig): Promise<void> {
  cache = config;
  await invoke("config_set", { value: config });
}

/** Convenience: toggle/patch a check-box key and persist. */
export async function setCheckbox(key: string, value: boolean): Promise<void> {
  const cfg = getConfig();
  cfg["check-box"][key] = value;
  await writeConfig(cfg);
}

export async function resetConfig(): Promise<TremConfig> {
  cache = await invoke<TremConfig>("config_reset");
  return cache;
}

/** Re-read config whenever any window changes it. Returns an unlisten fn. */
export async function onConfigUpdated(fn: (c: TremConfig) => void): Promise<() => void> {
  return listen("config-updated", async () => {
    const c = await loadConfig(true);
    fn(c);
  });
}
