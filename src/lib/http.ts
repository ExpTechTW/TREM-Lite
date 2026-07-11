/**
 * HTTP client — uses tauri-plugin-http's `fetch` (bypasses CORS, native TLS),
 * replacing the undici-based legacy/src/js/core/utils/fetch.js.
 * Provides a timeout+abort wrapper and keeps a simple online/offline flag.
 */
import { appFetch } from "./env";

export class FetchError extends Error {
  type: "TIMEOUT" | "NETWORK_ERROR";
  constructor(message: string, type: "TIMEOUT" | "NETWORK_ERROR") {
    super(message);
    this.name = "FetchError";
    this.type = type;
  }
}

export interface Controlled {
  execute: () => Promise<Response>;
  controller: AbortController;
}

/** One-shot fetch with a timeout (ms). Throws FetchError on timeout/failure. */
export async function fetchData(url: string, timeout = 1000): Promise<Response> {
  const { execute } = withController(url, timeout);
  return execute();
}

/** Returns an abortable fetcher (mirrors fetchData.withController). */
export function withController(url: string, timeout = 1000): Controlled {
  const controller = new AbortController();
  const execute = async (): Promise<Response> => {
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await appFetch(url, {
        signal: controller.signal,
        headers: { "Cache-Control": "no-cache" },
      });
      return res;
    } catch (err) {
      if (controller.signal.aborted) {
        throw new FetchError(`Request timeout: ${url}`, "TIMEOUT");
      }
      throw new FetchError(`Network error: ${String(err)}`, "NETWORK_ERROR");
    } finally {
      clearTimeout(timer);
    }
  };
  return { execute, controller };
}

/** Fetch + parse JSON, returns null on any failure. */
export async function fetchJson<T>(url: string, timeout = 1000): Promise<T | null> {
  try {
    const res = await fetchData(url, timeout);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
