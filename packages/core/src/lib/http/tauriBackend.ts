/**
 * Desktop backend — hands every buffered request to the Rust proxy
 * (`apps/desktop/src-tauri/src/http_proxy.rs`), which owns ETag revalidation,
 * forced gzip and the 250 MB SQLite LRU.
 *
 * SSE stays on `tauri-plugin-http`'s streaming `fetch`: a command returns one
 * buffer, which an endless stream never produces.
 */
import { invoke } from "@tauri-apps/api/core";
 
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { HttpError, HttpResponse, type HttpBackend, type HttpMeta } from "./types";

/**
 * Decode `[u32 LE meta length][meta JSON][body bytes]`.
 *
 * The body rides as raw bytes rather than as a field inside a JSON payload —
 * Tauri would otherwise serialise a tile-sized `Vec<u8>` as an array of
 * numbers.
 */
function decodeFrame(buffer: ArrayBuffer): HttpResponse {
  const view = new DataView(buffer);
  const metaLength = view.getUint32(0, true);
  const metaBytes = new Uint8Array(buffer, 4, metaLength);
  const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as HttpMeta;
  const body = new Uint8Array(buffer, 4 + metaLength);
  return new HttpResponse(meta, body);
}

/**
 * A Tauri command can't be cancelled mid-flight, so an abort settles the
 * caller's promise and lets the in-flight request finish and populate the
 * cache. The Rust side still enforces the timeout, so nothing leaks.
 */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new HttpError("Aborted", "ABORTED"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new HttpError("Aborted", "ABORTED"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export const tauriBackend: HttpBackend = {
  async request(url, options) {
    const call = invoke<ArrayBuffer>("http_request", {
      req: {
        url,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
        timeoutMs: options.timeout,
        store: options.store ?? true,
      },
    });

    let buffer: ArrayBuffer;
    try {
      buffer = await withAbort(call, options.signal);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const message = String(err);
      // The Rust side reports a reqwest timeout inside its network error text.
      const timedOut = message.includes("timed out") || message.includes("timeout");
      throw new HttpError(message, timedOut ? "TIMEOUT" : "NETWORK_ERROR");
    }
    return decodeFrame(buffer);
  },

  stream(url, options) {
    // plugin-http gives a real streaming ReadableStream, which a buffered
    // command result cannot. Lifetime is the caller's via options.signal.
    return tauriFetch(url, {
      method: options.method ?? "GET",
      signal: options.signal,
      headers: options.headers,
    });
  },
};
