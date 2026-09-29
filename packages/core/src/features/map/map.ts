/**
 * Map bootstrap — ported from legacy/src/js/index/map.js.
 * MapLibre runs natively in the webview. Marker PNGs are now bundled Vite assets.
 */
import maplibregl, { type Map as MlMap } from "maplibre-gl";

import gpsPng from "@/assets/map/gps.png";
import crossPng from "@/assets/map/cross.png";
import cross1Png from "@/assets/map/cross1.png";
import cross2Png from "@/assets/map/cross2.png";
import cross3Png from "@/assets/map/cross3.png";
import cross4Png from "@/assets/map/cross4.png";
import { COLOR, MAP } from "@/lib/constants";
import { proxied, registerMapProtocol } from "@/lib/http/mapProtocol";
import { events } from "@/lib/events";
import { createLogger } from "@/lib/logger";
import { repaintTowns } from "@/lib/mapSource";
import { mark } from "@/lib/perf";
import { variable } from "@/lib/variable";
import { createIntensityIcon, createIntensityIconSquare } from "@/domain/utils";

const log = createLogger("map");

// Keep the base map and terrain definition aligned with DPIP's shared map
// style. The DEM tiles are native Mapbox Terrain-RGB, so MapLibre can render
// the relief directly without an app-side elevation conversion.
// Tile/glyph traffic is rewritten onto the `trem://` protocol so it goes
// through the HTTP proxy instead of the WebView's own network stack. Tiles
// are the biggest winner from the 250 MB ETag LRU: large, near-static, and
// re-requested every launch.
const BASEMAP_TILE_URL = proxied("https://static.lb.exptech.dev/api/v1/map/tiles/{z}/{x}/{y}.pbf");
const BASEMAP_SOURCE_MAX_ZOOM = 9;
const TERRAIN_TILE_URL = proxied("https://static.lb.exptech.dev/api/v1/map/terrain/{z}/{x}/{y}.png");
const TERRAIN_SOURCE_MAX_ZOOM = 11;
const TERRAIN_SOURCE_ID = "terrain";
const TERRAIN_HILLSHADE_LAYER_ID = "terrain-hillshade";

function buildMap(container: HTMLElement): MlMap {
  // Must happen before the Map is constructed — the style references trem:// URLs.
  registerMapProtocol();
  return new maplibregl.Map({
    container,
    // MapLibre 5 asks for the discrete GPU by default, and on a dual-GPU
    // laptop WebKit keeps it powered for as long as the map exists, drawing or
    // not. The integrated GPU renders this map identically.
    canvasContextAttributes: { powerPreference: "default" },
    // No symbol fade. Every icon here allows overlap, so nothing is ever hidden
    // by a collision; the 300 ms fade only animated icons appearing and going,
    // and it kept the map redrawing while it ran — for the EEW cross, which
    // appears twice a second, for 300 ms of every flash. With the cross the
    // only thing changing, the map drew 17.7 frames a second with the fade
    // and 7 without. Icons now appear at once, as the lines already did.
    fadeDuration: 0,
    style: {
      version: 8,
      name: "ExpTech Studio",
      sources: {
        map: {
          type: "vector",
          // Inline the tile template (from .../tiles/tiles.json) instead of a
          // remote `url`. MapLibre must fetch a source's TileJSON before the
          // style can finish loading; through a slow/interfering system proxy
          // (e.g. Surge) that fetch intermittently stalls, so `isStyleLoaded()`
          // never turns true and `MapLoad` — which gates the ENTIRE data/render
          // pipeline (dots, reports, layers) — never fires. Inlining removes
          // that blocking dependency so the style parses synchronously.
          tiles: [BASEMAP_TILE_URL],
          minzoom: 0,
          maxzoom: BASEMAP_SOURCE_MAX_ZOOM,
          // Towns are coloured by feature state, keyed by town code (paintTowns).
          promoteId: { town: "CODE" },
        },
        [TERRAIN_SOURCE_ID]: {
          type: "raster-dem",
          tiles: [TERRAIN_TILE_URL],
          encoding: "mapbox",
          tileSize: 512,
          minzoom: 0,
          maxzoom: TERRAIN_SOURCE_MAX_ZOOM,
          // Deliberately wider than Taiwan so the edge of the DEM never appears
          // as a hard line while the user pans around the supported viewport.
          bounds: [110, 10, 132, 35],
        },
      },
      sprite: "",
      glyphs: proxied("https://cdn.jsdelivr.net/gh/exptechtw/map-assets/{fontstack}/{range}.pbf"),
      layers: [
        { id: "background", type: "background", paint: { "background-color": COLOR.MAP.BACKGROUND } },
        {
          id: "global",
          type: "fill",
          source: "map",
          "source-layer": "global",
          paint: { "fill-color": COLOR.MAP.GLOBAL_FILL, "fill-opacity": 1 },
        },
        {
          id: "county",
          type: "fill",
          source: "map",
          "source-layer": "city",
          paint: { "fill-color": COLOR.MAP.TW_COUNTY_FILL, "fill-opacity": 1 },
        },
        {
          id: "town",
          type: "fill",
          source: "map",
          "source-layer": "town",
          paint: {
            "fill-color": ["coalesce", ["feature-state", "color"], COLOR.MAP.TW_TOWN_FILL],
            "fill-opacity": 1,
          },
        },
        {
          id: TERRAIN_HILLSHADE_LAYER_ID,
          type: "hillshade",
          source: TERRAIN_SOURCE_ID,
          paint: {
            "hillshade-illumination-direction": 335,
            "hillshade-exaggeration": 0.3,
          },
        },
        {
          id: "town-outline",
          type: "line",
          source: "map",
          "source-layer": "town",
          paint: {
            "line-color": COLOR.MAP.TW_TOWN_OUTLINE,
            "line-width": 0.4,
            "line-opacity": 0.7,
          },
        },
        {
          id: "county-outline",
          type: "line",
          source: "map",
          "source-layer": "city",
          paint: { "line-color": COLOR.MAP.TW_COUNTY_OUTLINE },
        },
        {
          id: "tsunami",
          type: "line",
          source: "map",
          "source-layer": "tsunami",
          paint: { "line-opacity": 0, "line-width": 3 },
        },
      ],
    },
    center: [121.6, 23.5],
    zoom: 6.8,
    attributionControl: false,
    pitchWithRotate: false,
    dragRotate: false,
    maxZoom: 12,
    minZoom: 4,
  });
}

/**
 * Lets the map finish loading in a window that starts hidden.
 *
 * MapLibre processes its style — and renders — on animation frames, and a
 * hidden WKWebView fires none. A window autostarted into the tray therefore
 * never loaded its map, and everything waiting on `MapLoad`, the data pipeline
 * included, waited with it. Until the map has loaded, a hidden page gets
 * timer-driven frames; after that the native ones are restored, and renders
 * simply pause for as long as nothing is on screen.
 *
 * Timer frames get negative ids. A frame requested before the restore and
 * cancelled after it then reaches the native `cancelAnimationFrame`, which
 * ignores a negative id rather than cancelling some unrelated frame.
 */
function framesUntilLoaded(): () => void {
  if (document.visibilityState !== "hidden") return () => {};
  const { requestAnimationFrame: raf, cancelAnimationFrame: caf } = window;
  window.requestAnimationFrame = (cb) => -window.setTimeout(() => cb(performance.now()), 16);
  window.cancelAnimationFrame = (id) => (id < 0 ? window.clearTimeout(-id) : caf.call(window, id));
  return () => {
    window.requestAnimationFrame = raf;
    window.cancelAnimationFrame = caf;
  };
}

function initMap(container: HTMLElement): Promise<MlMap> {
  return new Promise((resolve) => {
    const restoreFrames = framesUntilLoaded();
    const map = buildMap(container);
    let done = false;
    const finish = (why: string) => {
      if (done) return;
      done = true;
      restoreFrames();
      log.info(`地圖樣式就緒（${why}）`);
      resolve(map);
    };
    // Only resolve once the STYLE is actually loaded — feature modules add
    // sources/layers on MapLoad and map.addSource throws if the style isn't ready.
    // WKWebView's `load`/`idle`/`styledata` timing is flaky, so we accept any of
    // them (all gated on isStyleLoaded) and keep a long last-resort cap.
    map.on("load", () => finish("load"));
    map.on("idle", () => finish("idle"));
    map.on("styledata", () => {
      if (map.isStyleLoaded()) finish("styledata");
    });
    map.on("error", (e: unknown) => {
      const msg = (e as { error?: { message?: string } })?.error?.message ?? String(e);
      // tile/glyph fetch failures (empty 404 tiles → "Load failed (0)") are
      // non-fatal — they must never block the style load.
      if (msg.includes(".pbf") || msg.includes(".png") || msg.includes("Load failed")) return;
      log.warn(`地圖錯誤：${msg}`);
    });
    // Poll as a belt-and-braces (some styledata events don't refire once ready).
    const poll = setInterval(() => {
      if (map.isStyleLoaded()) {
        clearInterval(poll);
        finish("poll");
      }
    }, 250);
    // Absolute last resort so the data pipeline never hangs forever.
    setTimeout(() => {
      clearInterval(poll);
      if (!done) {
        log.warn("地圖樣式 20s 內沒有就緒，照樣繼續，不讓資料流程卡住");
        finish("timeout");
      }
    }, 20000);
  });
}

async function addPng(map: MlMap, id: string, url: string) {
  try {
    const img = await map.loadImage(url);
    if (!map.hasImage(id)) map.addImage(id, img.data);
  } catch (e) {
    log.debug(`地圖圖示 ${id} 載入失敗：`, e);
  }
}

/** Register the generated intensity sprites + bundled cross/gps PNGs. */
async function addImages(map: MlMap) {
  const icons = [
    { id: "0", i: 0 },
    { id: "1", i: 1 },
    { id: "2", i: 2 },
    { id: "3", i: 3 },
    { id: "4", i: 4 },
    { id: "5⁻", i: 5 },
    { id: "5⁺", i: 6 },
    { id: "6⁻", i: 7 },
    { id: "6⁺", i: 8 },
    { id: "7", i: 9 },
  ];

  icons.forEach((icon, index) => {
    const bg = COLOR.INTENSITY[icon.i];
    const text = COLOR.INTENSITY_TEXT[icon.i];
    const image = createIntensityIcon(icon.id, bg, text, text);
    image.onload = () => !map.hasImage(`intensity-${index}`) && map.addImage(`intensity-${index}`, image);
    const sq = createIntensityIconSquare(icon.id, bg, text, text);
    sq.onload = () =>
      !map.hasImage(`intensity-square-${index}`) && map.addImage(`intensity-square-${index}`, sq);
  });

  ([1, 2, 3, 4] as const).forEach((lv) => {
    const bg = COLOR.LPGM[lv];
    const text = COLOR.LPGM_TEXT[lv];
    const sq = createIntensityIconSquare(String(lv), bg, text, text);
    sq.onload = () => !map.hasImage(`lpgm-${lv}`) && map.addImage(`lpgm-${lv}`, sq);
  });

  await addPng(map, "gps", gpsPng);
  await addPng(map, "cross", crossPng);
  await addPng(map, "cross1", cross1Png);
  await addPng(map, "cross2", cross2Png);
  await addPng(map, "cross3", cross3Png);
  await addPng(map, "cross4", cross4Png);
}

/** How long a lost WebGL context gets to come back before the page reloads. */
const RESTORE_MS = 5_000;
/** At most one reload for the map per this long, so a failing GPU cannot loop. */
const RELOAD_EVERY_MS = 10 * 60_000;
const RELOADED_AT_KEY = "trem.map.reloadedAt";

/**
 * The WebGL context behind the map can be lost: macOS terminates WebKit's GPU
 * process when it stops answering (it did at 20:17 on 9-29, just after the
 * display woke), and memory pressure can take it. MapLibre then drops its
 * style — `map.style` is null — and waits for the context to return; any
 * getSource or setFeatureState meanwhile throws. On 9-29 it never returned:
 * the map was blank for hours, and every RTS frame threw.
 *
 * While lost, `variable.map` is null. Every module already skips its map work
 * then, so data, sound, speech and notifications go on. Restored, and its
 * style loaded again, within RESTORE_MS, the map is handed back and the towns
 * coloured again. Not, the page reloads — a new context, a new map, every
 * module's state fresh — at most once per RELOAD_EVERY_MS.
 */
function watchContext(map: MlMap): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  map.on("webglcontextlost", () => {
    log.warn(
      `地圖的 WebGL context 遺失（GPU 程序重啟或記憶體不足）：地圖先停用，其他功能照常，等 ${RESTORE_MS / 1000}s 看會不會恢復`,
    );
    if (variable.map === map) variable.map = null;
    timer ??= setTimeout(() => {
      timer = null;
      reloadForMap();
    }, RESTORE_MS);
  });
  // MapLibre sets the saved style again, which is processed on a later frame:
  // until then a feature-state write throws "Style is not done loading". The
  // map is handed back on `style.load` — tiles may still be on their way,
  // which nothing here needs — and the reload stays armed until then. (A
  // hidden window draws no frames, so there the reload is what recovers it.)
  map.on("webglcontextrestored", () => {
    log.info("地圖的 WebGL context 已恢復，等樣式重新載入");
    map.once("style.load", () => {
      if (timer) clearTimeout(timer);
      timer = null;
      variable.map = map;
      repaintTowns(map);
      log.info("地圖樣式已重新載入，地圖重新啟用");
    });
  });
}

function reloadForMap(): void {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(RELOADED_AT_KEY)) || 0;
  } catch {
    /* no sessionStorage: reload anyway */
  }
  if (Date.now() - last < RELOAD_EVERY_MS) {
    log.error(
      `地圖的 WebGL context 仍未恢復，而 ${RELOAD_EVERY_MS / 60_000} 分鐘內已經為此重新載入過：不再重新載入，地圖維持停用，其他功能照常`,
    );
    return;
  }
  try {
    sessionStorage.setItem(RELOADED_AT_KEY, String(Date.now()));
  } catch {
    /* the guard is lost, the reload is not */
  }
  log.warn(`地圖的 WebGL context ${RESTORE_MS / 1000}s 內沒有恢復，重新載入主畫面`);
  // A moment for that line to reach the log before the page goes.
  setTimeout(() => location.reload(), 300);
}

/** Boot the map into `container`, populate `variable.map`, emit `MapLoad`. */
export async function setupMap(container: HTMLElement): Promise<MlMap> {
  const map = await initMap(container);
  watchContext(map);
  map.on("resize", () => map.fitBounds(MAP.BOUNDS, MAP.OPTIONS));
  map.resize();
  map.fitBounds(MAP.BOUNDS, MAP.OPTIONS);
  // Images are for markers only — never let them block MapLoad (and the data layer).
  try {
    await addImages(map);
  } catch (e) {
    log.warn("地圖圖示載入失敗（不影響其他功能）：", e);
  }
  variable.map = map;
  mark("map-ready");
  events.emit("MapLoad");
  log.info("地圖圖層與圖示都已加上，通知各模組（MapLoad）");
  return map;
}
