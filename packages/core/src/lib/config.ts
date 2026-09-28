/**
 * Config client — talks to the Rust YAML config store (config.rs).
 * Replaces legacy/src/js/core/config.js (electron-store/YAML + IPC).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { inTauri } from "./env";
import { createLogger } from "./logger";
import type { TremConfig } from "./types";

const log = createLogger("config");

/** `{ a: { b: 1 } }` → `{ "a.b": 1 }`. */
function flatten(value: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix] = value;
  }
  return out;
}

/** 每個改了的設定一段：`鍵：舊 → 新`。 */
function changes(before: unknown, after: unknown): string[] {
  const a = flatten(before);
  const b = flatten(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .map((k) => `${k}：${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`);
}

/** 整份設定一行，給啟動與還原時記錄。 */
function describe(config: TremConfig): string {
  return Object.entries(flatten(config))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
}

/** Mirrors src-tauri/default.yml — used as the browser-mode / fallback config. */
export const DEFAULT_CONFIG: TremConfig = {
  ver: 6,
  "realtime-station-id": "1C10848",
  "check-box": {
    "show-window-eew": true,
    "show-window-report": true,
    "show-window-detect": true,
    "show-window-rts-intensity": true,
    "other-auto-start": true,
    "update-auto-restart": true,
    "other-tts": true,
    "graphics-block-auto-zoom": false,
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
};

let cache: TremConfig | null = null;

/** Load (and cache) the full config. */
export async function loadConfig(force = false): Promise<TremConfig> {
  if (cache && !force) return cache;
  const first = !cache;
  // Browser mode (headless WebKit debugging): no Rust backend — use defaults.
  if (!inTauri) {
    try {
      const saved = localStorage.getItem("trem.config");
      cache = saved ? (JSON.parse(saved) as TremConfig) : structuredClone(DEFAULT_CONFIG);
      if (first) log.info(`載入設定（${saved ? "瀏覽器儲存" : "預設值"}）：${describe(cache)}`);
    } catch (e) {
      log.warn("瀏覽器裡的設定讀不出來，改用預設值：", e);
      cache = structuredClone(DEFAULT_CONFIG);
    }
    return cache;
  }
  cache = await invoke<TremConfig>("config_get");
  if (first) log.info(`載入設定：${describe(cache)}`);
  return cache;
}

/** Synchronous access to the last-loaded config (falls back to defaults). */
export function getConfig(): TremConfig {
  if (!cache) cache = structuredClone(DEFAULT_CONFIG);
  return cache;
}

/** Persist the whole config. Broadcasts `config-updated` from Rust. */
export async function writeConfig(config: TremConfig): Promise<void> {
  const diff = changes(cache, config);
  if (diff.length) log.info(`設定變更：${diff.join("；")}`);
  cache = config;
  if (!inTauri) {
    localStorage.setItem("trem.config", JSON.stringify(config));
    return;
  }
  await invoke("config_set", { value: config });
}

export async function resetConfig(): Promise<TremConfig> {
  if (!inTauri) {
    cache = structuredClone(DEFAULT_CONFIG);
    localStorage.setItem("trem.config", JSON.stringify(cache));
  } else {
    cache = await invoke<TremConfig>("config_reset");
  }
  log.info(`所有設定還原為預設值：${describe(cache)}`);
  return cache;
}

/** Re-read config whenever any window changes it. Returns an unlisten fn. */
export async function onConfigUpdated(fn: (c: TremConfig) => void): Promise<() => void> {
  if (!inTauri) return () => {};
  return listen("config-updated", async () => {
    const c = await loadConfig(true);
    fn(c);
  });
}
