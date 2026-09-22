/**
 * Browser backend — used by `apps/web`, by the headless-WebKit screenshot
 * harness, and for same-origin bundled assets in every runtime.
 *
 * There is no SQLite here, so ETag revalidation and gzip are delegated to the
 * browser's own HTTP cache: `cache: "default"` lets it send `If-None-Match`
 * and handle the 304, and `Accept-Encoding` is set by the browser itself and
 * is not settable from script.
 */
import { HttpError, HttpResponse, type HttpBackend, type HttpOptions } from "./types";

/** Merge a caller signal with our own timeout into one signal. */
function linkSignals(timeout: number | undefined, external: AbortSignal | undefined) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  if (timeout != null) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
  }
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", () => controller.abort(), { once: true });
  }

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    done: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

async function run(url: string, options: HttpOptions): Promise<Response> {
  const link = linkSignals(options.timeout, options.signal);
  try {
     
    return await fetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      signal: link.signal,
      cache: options.store === false ? "no-store" : "default",
    });
  } catch (err) {
    if (link.didTimeOut()) throw new HttpError(`Request timed out: ${url}`, "TIMEOUT");
    if (link.signal.aborted) throw new HttpError("Aborted", "ABORTED");
    throw new HttpError(`Network error: ${String(err)}`, "NETWORK_ERROR");
  } finally {
    link.done();
  }
}

export const webBackend: HttpBackend = {
  async request(url, options) {
    const res = await run(url, options);
    const headers: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return new HttpResponse(
      {
        status: res.status,
        ok: res.ok,
        url: res.url || url,
        headers,
        // The browser cache is opaque to us; it may well have served this from
        // disk, but it never tells us so.
        fromCache: false,
        stale: false,
      },
      bytes,
    );
  },

  stream(url, options) {
    return run(url, { ...options, store: false, timeout: undefined });
  },
};
