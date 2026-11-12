/**
 * 擴充功能 — the extension host, started from `features/index.ts`.
 *
 * V3 created its plugin loader before any feature module (`index/require.js`
 * ran `createPluginLoader('index')` first); the same order is kept here so a
 * plugin subscribed to `DataRts` hears the session's first frame.
 *
 * Loading is asynchronous because the plugin tree is a Rust call. Nothing here
 * blocks the app: a plugin that fails to load is a row in 設定 → 擴充 that says
 * so, never a boot that stops.
 */
import { createLogger } from "@/lib/logger";

import { pluginStorageAvailable } from "./bridge";
import { createPluginLoader } from "./host";

const log = createLogger("plugin");

export function initPlugins(): void {
  // A browser tab has no plugin folder and no way to run what a plugin reaches
  // for. 設定 → 擴充 says so rather than offering an install that cannot work.
  if (!pluginStorageAvailable) return;

  const loader = createPluginLoader("index");
  loader.load().catch((e: unknown) => {
    log.error(`擴充功能載入失敗：${String(e)}`);
  });
}

/**
 * 設定 → 擴充 — the same loader, without the loading.
 *
 * The settings window is a second webview: it lists the extensions, verifies
 * them, installs, removes and records what is enabled, but it must not start
 * one — a plugin reaches for the map, the station feed and the audio engine,
 * and those live in the main window. V3 read `enabled-plugins` at boot as well,
 * so a change made here takes effect the next time the app starts.
 */
export function initPluginAdmin(): void {
  if (!pluginStorageAvailable) return;

  const loader = createPluginLoader("index", { management: true });
  loader.scan().catch((e: unknown) => {
    log.error(`擴充功能清單讀取失敗：${String(e)}`);
  });
}

export { createPluginLoader, pluginLoader, PluginLoader, getSensitivityDescription } from "./host";
export { pluginStorageAvailable } from "./bridge";
export type { LoaderOptions, PluginContext } from "./host";
export { MixinManager } from "./mixin";
export { authorNames, localizedText } from "./types";
export type { LoadedPlugin, LocalizedText, PluginEntry, PluginInfo } from "./types";
