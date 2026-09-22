/**
 * The app's single HTTP entry point. **Nothing outside this directory may call
 * `fetch`, `XMLHttpRequest` or `@tauri-apps/plugin-http` directly** — the
 * ESLint config in `packages/core/eslint.config.js` enforces that, so any new
 * network code has to come through here.
 *
 * What the layer guarantees:
 *
 * | | desktop (Tauri) | web / headless browser |
 * |---|---|---|
 * | transport | Rust `http_request` command (reqwest) | `window.fetch` |
 * | gzip | forced `Accept-Encoding: gzip`, stored re-gzipped at max level | browser-managed |
 * | ETag | `If-None-Match` from a SQLite store, 250 MB LRU | browser HTTP cache |
 * | stale-on-error | yes — cached body served when the network fails | no |
 *
 * Two shapes of request exist:
 *
 * * {@link http.request} / {@link http.json} / {@link http.bytes} — buffered,
 *   cached by default.
 * * {@link http.stream} — long-lived SSE, never cached. A cache has nothing to
 *   offer an endless stream, but the call still routes through this layer so
 *   there is exactly one place that knows how the app reaches the network.
 */
import { invoke } from "@tauri-apps/api/core";

import { inTauri } from "@/lib/env";

import { tauriBackend } from "./tauriBackend";
import { webBackend } from "./webBackend";
import { HttpError, HttpResponse, type HttpBackend, type HttpOptions } from "./types";

export { HttpError, HttpResponse } from "./types";
export type { HttpMeta, HttpMethod, HttpOptions } from "./types";

const backend: HttpBackend = inTauri ? tauriBackend : webBackend;

export interface HttpCacheStats {
  entries: number;
  bytes: number;
  maxBytes: number;
}

export const http = {
  /** Buffered request. Throws {@link HttpError} on timeout/network failure. */
  request(url: string, options: HttpOptions = {}): Promise<HttpResponse> {
    return backend.request(url, options);
  },

  /** Buffered request parsed as JSON. Returns `null` on any failure. */
  async json<T>(url: string, options: HttpOptions = {}): Promise<T | null> {
    try {
      const res = await backend.request(url, options);
      if (!res.ok) return null;
      return await res.json<T>();
    } catch {
      return null;
    }
  },

  /** Buffered request as raw bytes. Throws on failure or a non-2xx status. */
  async bytes(url: string, options: HttpOptions = {}): Promise<Uint8Array> {
    const res = await backend.request(url, options);
    if (!res.ok) throw new HttpError(`HTTP ${res.status}: ${url}`, "NETWORK_ERROR");
    return res.bytes;
  },

  /**
   * Long-lived response for SSE. Never cached, no timeout — the caller owns
   * the lifetime through `options.signal`.
   */
  stream(url: string, options: HttpOptions = {}): Promise<Response> {
    return backend.stream(url, { ...options, store: false });
  },

  /**
   * Same-origin asset bundled by Vite (`@/data/*.bin?url`). These never touch
   * the proxy — the Rust side only speaks https to the allowlisted hosts, and
   * the bytes are already local — but they stay inside this layer so the "no
   * bare fetch" rule holds everywhere.
   */
  async asset(url: string): Promise<Uint8Array> {
    const res = await webBackend.request(url, {});
    if (!res.ok) throw new HttpError(`HTTP ${res.status}: ${url}`, "NETWORK_ERROR");
    return res.bytes;
  },

  /** Cache occupancy, for the settings/debug surface. `null` off-desktop. */
  async cacheStats(): Promise<HttpCacheStats | null> {
    if (!inTauri) return null;
    try {
      return await invoke<HttpCacheStats>("http_cache_stats");
    } catch {
      return null;
    }
  },

  async clearCache(): Promise<void> {
    if (!inTauri) return;
    try {
      await invoke("http_cache_clear");
    } catch {
      /* clearing a cache is best-effort */
    }
  },
};

/* ------------------------------------------------------------------------ *
 * Compatibility surface
 *
 * These keep the shape the call sites used before the proxy existed
 * (`fetchData` / `withController` / `fetchJson`). New code should prefer the
 * `http` object above, which exposes the cache controls.
 * ------------------------------------------------------------------------ */

/** @deprecated Use {@link HttpError}. */
export const FetchError = HttpError;

export interface Controlled {
  execute: () => Promise<HttpResponse>;
  controller: AbortController;
}

/** One-shot request with a timeout. Throws {@link HttpError}. */
export function fetchData(
  url: string,
  timeout = 1000,
  options: HttpOptions = {},
): Promise<HttpResponse> {
  return http.request(url, { ...options, timeout });
}

/** Abortable request; the caller keeps the controller to cancel in flight. */
export function withController(
  url: string,
  timeout = 1000,
  options: HttpOptions = {},
): Controlled {
  const controller = new AbortController();
  return {
    controller,
    execute: () => http.request(url, { ...options, timeout, signal: controller.signal }),
  };
}

/** Request + JSON parse, `null` on any failure. */
export function fetchJson<T>(
  url: string,
  timeout = 1000,
  options: HttpOptions = {},
): Promise<T | null> {
  return http.json<T>(url, { ...options, timeout });
}
