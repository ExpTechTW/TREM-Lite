/**
 * Browser backend — used by `apps/web`, by the headless-WebKit screenshot
 * harness, and for same-origin bundled assets in every runtime.
 *
 * There is no SQLite here, so ETag revalidation and gzip are delegated to the
 * browser's own HTTP cache: `cache: "default"` lets it send `If-None-Match`
 * and handle the 304, and `Accept-Encoding` is set by the browser itself and
 * is not settable from script. That cache obeys `no-store`, which the map
 * tiles are sent with, so a request with `maxAge` is kept in Cache Storage
 * instead, as the proxy keeps it on desktop.
 */
import { alternative, report, route, type Route } from "./regions";
import { HttpError, HttpResponse, type HttpBackend, type HttpOptions } from "./types";
import { watchBody } from "./watchBody";

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

const aborted = (err: unknown) => err instanceof HttpError && err.type === "ABORTED";

const FRESH_CACHE = "trem-fresh";
/** When a kept copy was stored (ms), on the copy itself. */
const STORED_AT = "x-trem-stored-at";

/** A kept copy of `url` younger than `maxAge`, if there is one. */
async function freshCopy(url: string, maxAge: number): Promise<Response | null> {
  try {
    const hit = await (await caches.open(FRESH_CACHE)).match(url);
    const age = Date.now() - Number(hit?.headers.get(STORED_AT));
    return hit && age >= 0 && age < maxAge ? hit : null;
  } catch {
    return null; // no Cache Storage (an insecure origin, a private window)
  }
}

async function keep(url: string, res: Response): Promise<void> {
  try {
    const headers = new Headers(res.headers);
    headers.set(STORED_AT, String(Date.now()));
    const copy = new Response(await res.arrayBuffer(), { status: res.status, headers });
    await (await caches.open(FRESH_CACHE)).put(url, copy);
  } catch {
    /* not kept: fetched again next time */
  }
}

/** One attempt at a route, its outcome told to the node's health. */
async function attempt(r: Route, options: HttpOptions): Promise<Response> {
  try {
    const res = await run(r.url, options);
    if (r.target) report(r.target, res.status < 500);
    return res;
  } catch (err) {
    if (r.target && !aborted(err)) report(r.target, false);
    throw err;
  }
}

/** Tries per request, the first included — the proxy's rule (http_proxy.rs). */
const MAX_ATTEMPTS = 3;
/** The first backoff; each retry on the same node waits twice the last. */
const BACKOFF_BASE_MS = 300;
const MAX_RETRY_AFTER_MS = 60_000;

const retryable = (status: number) => status >= 500 || status === 429;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new HttpError("Aborted", "ABORTED"));
      },
      { once: true },
    );
  });

/**
 * As the desktop's proxy does: no answer, a 5xx or a 429 is tried again, up to
 * MAX_ATTEMPTS times within the caller's timeout — at once on another healthy
 * node when there is one, else after an exponential backoff, or the server's
 * Retry-After.
 */
async function send(url: string, options: HttpOptions): Promise<Response> {
  const deadline = options.timeout == null ? Infinity : performance.now() + options.timeout;
  let target = route(url);
  let last: Response | unknown = null;
  for (let tries = 1; tries <= MAX_ATTEMPTS; tries++) {
    const left = deadline - performance.now();
    if (left <= 0) break;
    let wait = BACKOFF_BASE_MS * 2 ** (tries - 1) * (0.9 + Math.random() * 0.2);
    try {
      const res = await attempt(target, { ...options, timeout: Number.isFinite(left) ? left : undefined });
      if (!retryable(res.status)) return res;
      last = res;
      const after = Number(res.headers.get("retry-after"));
      if (res.status === 429 && after > 0) wait = Math.min(after * 1000, MAX_RETRY_AFTER_MS);
    } catch (err) {
      if (aborted(err)) throw err;
      last = err;
    }
    if (tries === MAX_ATTEMPTS) break;
    const next = alternative(target);
    if (next) {
      target = next;
      continue;
    }
    if (performance.now() + wait >= deadline) break;
    await sleep(wait, options.signal);
  }
  if (last instanceof Response) return last;
  throw last ?? new HttpError(`Request timed out: ${url}`, "TIMEOUT");
}

export const webBackend: HttpBackend = {
  async request(url, options) {
    const kept = options.maxAge ? await freshCopy(url, options.maxAge) : null;
    const res = kept ?? (await send(url, options));
    if (!kept && options.maxAge && res.status === 200) void keep(url, res.clone());
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
        // A kept copy is ours to know about. The browser cache is opaque: it
        // may well have served the rest from disk, but it never says so.
        fromCache: !!kept,
        stale: false,
      },
      bytes,
    );
  },

  async stream(url, options) {
    const r = route(url);
    const res = await attempt(r, { ...options, store: false, timeout: undefined });
    const target = r.target;
    return target ? watchBody(res, () => report(target, false), options.signal) : res;
  },
};
