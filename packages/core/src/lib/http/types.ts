/**
 * Shared contract between the HTTP abstraction layer's public API and its
 * per-runtime backends (Tauri proxy / plain browser).
 */

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "DELETE";

export interface HttpOptions {
  method?: HttpMethod;
  headers?: Record<string, string>;
  /** Abort after this many ms. Enforced natively by the Rust proxy. */
  timeout?: number;
  signal?: AbortSignal;
  /**
   * Persist the response in the SQLite ETag/LRU store (desktop) or allow the
   * browser HTTP cache to revalidate it (web). Defaults to `true`.
   *
   * Pass `false` only for payloads that change on every request — the 1 Hz
   * rts/eew pollers and the node health probes — where a stored copy can never
   * be revalidated and would only evict entries that can.
   */
  store?: boolean;
}

/** Metadata the Rust proxy frames ahead of the response body. */
export interface HttpMeta {
  status: number;
  ok: boolean;
  url: string;
  headers: Record<string, string>;
  /** Body was replayed from the cache (304 revalidation, or stale-on-error). */
  fromCache: boolean;
  /** Served without a successful revalidation — may be out of date. */
  stale: boolean;
}

export type HttpErrorKind = "TIMEOUT" | "NETWORK_ERROR" | "ABORTED";

export class HttpError extends Error {
  readonly type: HttpErrorKind;

  constructor(message: string, type: HttpErrorKind) {
    super(message);
    this.name = "HttpError";
    this.type = type;
  }
}

/**
 * A `Response`-shaped result. The surface is deliberately the subset of the
 * DOM `Response` that the app actually uses, so call sites read the same as
 * they did before the proxy existed.
 */
export class HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly fromCache: boolean;
  readonly stale: boolean;
  readonly bytes: Uint8Array;

  constructor(meta: HttpMeta, bytes: Uint8Array) {
    this.status = meta.status;
    this.ok = meta.ok;
    this.url = meta.url;
    this.headers = meta.headers;
    this.fromCache = meta.fromCache;
    this.stale = meta.stale;
    this.bytes = bytes;
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    // Slice so the caller can't observe (or detach) the backing buffer when
    // the view is a window onto a larger allocation.
    return Promise.resolve(
      this.bytes.buffer.slice(
        this.bytes.byteOffset,
        this.bytes.byteOffset + this.bytes.byteLength,
      ) as ArrayBuffer,
    );
  }

  text(): Promise<string> {
    return Promise.resolve(new TextDecoder().decode(this.bytes));
  }

  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }
}

export interface HttpBackend {
  request(url: string, options: HttpOptions): Promise<HttpResponse>;
  /** Long-lived, never-cached response used for SSE. */
  stream(url: string, options: HttpOptions): Promise<Response>;
}
