/**
 * Routes MapLibre's tile/glyph traffic through the HTTP proxy.
 *
 * Without this the tiles are fetched by MapLibre itself — on desktop that means
 * the WebView's own network stack, which bypasses every guarantee this layer
 * makes. Tiles are also the biggest beneficiary of the cache: large,
 * essentially static, and wanted again at every launch. They cannot be
 * revalidated — the tile server sends `no-store` and a Last-Modified that moves
 * forward every minute or so, so a conditional request downloads them afresh —
 * so they are kept for TILE_FRESH_MS and served from the cache meanwhile
 * without a request at all.
 *
 * Registering on the main thread is enough. Vector tiles are parsed on worker
 * threads, but MapLibre forwards a request whose protocol is unknown to the
 * worker back to the main-thread handler, transferring the resulting
 * `ArrayBuffer` rather than copying it.
 */
import maplibregl from "maplibre-gl";

import { createLogger } from "@/lib/logger";

import { http } from "./index";

const SCHEME = "trem";
const TILE_TIMEOUT = 15_000;
/** How long a tile, glyph range or terrain tile is served from the cache. */
const TILE_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

const log = createLogger("map-proto");
let registered = false;

/**
 * Rewrite an `https://` tile template to the proxied scheme. Templates keep
 * their `{z}/{x}/{y}` placeholders — MapLibre expands them before calling us.
 */
export function proxied(url: string): string {
  return url.replace(/^https:\/\//, `${SCHEME}://`);
}

export function registerMapProtocol(): void {
  if (registered) return;
  registered = true;

  maplibregl.addProtocol(SCHEME, async (params, abortController) => {
    const url = params.url.replace(new RegExp(`^${SCHEME}://`), "https://");
    const res = await http.request(url, {
      timeout: TILE_TIMEOUT,
      store: true,
      maxAge: TILE_FRESH_MS,
      signal: abortController.signal,
    });

    // Sparse tile pyramids answer 404 (or 204) for empty tiles; MapLibre treats
    // a null body as "nothing here" and carries on rendering.
    if (res.status === 404 || res.status === 204) return { data: null };
    if (!res.ok) throw new Error(`tile ${res.status}: ${url}`);

    return { data: await res.arrayBuffer() };
  });

  log.debug(`registered ${SCHEME}:// protocol`);
}
