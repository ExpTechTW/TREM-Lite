/**
 * Runtime environment detection. Lets the app degrade gracefully when it runs
 * in a plain browser (the web build, or headless WebKit for UI screenshots /
 * debugging) instead of the Tauri webview: config falls back to defaults, the
 * HTTP layer swaps its backend, native features no-op.
 *
 * Network access is NOT exposed here. Everything goes through `@/lib/http`,
 * which picks its backend from `inTauri` — see that module's header.
 */
export const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as object);
