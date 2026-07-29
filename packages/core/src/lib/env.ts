/**
 * Runtime environment detection. Lets the app degrade gracefully when it runs in
 * a plain browser (headless WebKit for UI screenshots / debugging) instead of the
 * Tauri webview: HTTP falls back to native fetch, config to defaults, etc.
 */
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as object);

/** fetch that works in both Tauri (plugin-http, CORS-free) and a plain browser. */
export const appFetch = (
  inTauri ? tauriFetch : window.fetch.bind(window)
) as typeof window.fetch;
