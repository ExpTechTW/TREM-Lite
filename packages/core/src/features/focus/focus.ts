// Ported from legacy/src/js/index/core/focus.js
import maplibregl, { type FitBoundsOptions, type LngLatBoundsLike, type Map as MlMap } from "maplibre-gl";

import { getConfig } from "@/lib/config";
import { MAP } from "@/lib/constants";
import { events } from "@/lib/events";
import { createLogger } from "@/lib/logger";
import { variable } from "@/lib/variable";

const log = createLogger("focus");

/** A single map coordinate. The `variable.cache.bounds.*` arrays hold these at runtime. */
interface Coord {
  lon: number;
  lat: number;
}

/** Optional overrides for {@link updateMapBounds}. */
interface FitOptions {
  paddingTop?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  paddingRight?: number;
  maxZoom?: number;
  duration?: number;
}

// Module-level state (replaces the old FocusManager singleton).
let lock = false;
let isMouseDown = false;
let mapInitialized = false;
let focusInterval: ReturnType<typeof setInterval> | null = null;

/**
 * The quickest the camera follows a change, and the fit's own duration: a
 * frame every 0.5 s must not restart the move before it lands.
 */
const FOCUS_GAP_MS = 800;
let lastFocus = -Infinity;
let pendingFocus: ReturnType<typeof setTimeout> | null = null;
/** The triggered stations the camera last followed, as a key. */
let rtsKey = "";

/**
 * Focus now, or — within FOCUS_GAP_MS of the last — once that has passed,
 * however many changes came meanwhile.
 */
function focusSoon(): void {
  if (pendingFocus) return;
  const wait = lastFocus + FOCUS_GAP_MS - performance.now();
  if (wait <= 0) {
    lastFocus = performance.now();
    focus();
    return;
  }
  pendingFocus = setTimeout(() => {
    pendingFocus = null;
    lastFocus = performance.now();
    focus();
  }, wait);
}


/** Set the auto-focus lock and notify the UI (e.g. tint the nav button). */
function setLock(v: boolean): void {
  if (lock === v) return;
  lock = v;
  events.emit("FocusLockChange", v);
}

/**
 * Read a `variable.cache.bounds.*` slot as coordinate objects. The shared
 * contract types these arrays as `number[]`, but every writer pushes `{lon,lat}`.
 */
function asCoords(bounds: number[]): Coord[] {
  return bounds as unknown as Coord[];
}

/** Register the periodic auto-focus tick plus the EEW + MapLoad subscriptions. */
export function initFocus(): void {
  if (focusInterval) {
    clearInterval(focusInterval);
  }
  focusInterval = setInterval(() => focus(), 3000);

  events.on("EewRelease", () => focus());
  events.on("EewUpdate", () => focus());
  events.on("EewEnd", () => focus());
  events.on("MapLoad", () => onMapLoad());

  // The triggered stations change: follow at once rather than at the next
  // three-second tick, which left a short trigger never followed at all. After
  // the frame's other handlers, rts.ts's among them, which sets the bounds.
  events.on("DataRts", () =>
    queueMicrotask(() => {
      const stations = asCoords(variable.cache.bounds.rts);
      const key = stations.map((c) => `${c.lon},${c.lat}`).sort().join("|");
      if (key === rtsKey) return;
      rtsKey = key;
      focusSoon();
    }),
  );
  // Brought forward, by an alert or by hand: where things are, now.
  events.on("MainWindowHidden", (hidden) => {
    if (!hidden) focusSoon();
  });
}

/** Any manual pan/zoom locks auto-focus until the React nav button resets it. */
function onMapLoad(): void {
  if (mapInitialized) {
    return;
  }
  const map = variable.map;
  if (!map) {
    return;
  }
  mapInitialized = true;

  // Any touch of the map locks auto-focus so the camera stops fighting the
  // user, until they press the nav focus button (red while locked) to release
  // it — nothing else releases it. A touch counts as much as a click: on a
  // phone a pinch sends no mouse event at all, and used to leave auto-focus
  // free to undo the zoom a moment later.
  const manual = (how: string) => {
    if (lock) return;
    log.debug(`使用者${how}地圖，自動聚焦暫停，按定位鈕恢復`);
    setLock(true);
  };
  map.on("mousedown", () => {
    isMouseDown = true;
    manual("點擊");
  });

  map.on("mouseup", () => {
    isMouseDown = false;
  });

  map.on("touchstart", () => manual("觸控"));
  map.on("wheel", () => manual("捲動縮放"));
  // The keyboard, or anything else a person started: only such a move carries
  // its originating event.
  map.on("movestart", (e) => {
    if (e.originalEvent) manual("操作");
  });
}

/** Whether auto-focus is currently locked by a manual map interaction. */
export function isAutoFocusLocked(): boolean {
  return lock;
}

/** Whether the user is actively dragging the map (mouse button held down). */
export function mouseDown(): boolean {
  return isMouseDown;
}

/** Recompute and apply the auto-focus camera from the cached bounds + live EEW. */
export function focus(): void {
  const config = getConfig();
  if (config["check-box"]["graphics-block-auto-zoom"]) {
    return;
  }
  if (lock) {
    return;
  }

  const bounds = variable.cache.bounds;

  if (asCoords(bounds.lpgm).length) {
    updateMapBounds(asCoords(bounds.lpgm));
    return;
  }

  if (asCoords(bounds.intensity).length) {
    updateMapBounds(asCoords(bounds.intensity));
    return;
  }

  const eewBounds: Coord[] = [];
  for (const eew of variable.data.eew) {
    eewBounds.push({ lon: eew.eq.lon, lat: eew.eq.lat });
  }

  const combined = [...asCoords(bounds.rts), ...eewBounds];

  if (combined.length) {
    updateMapBounds(combined);
  }
  else if (!asCoords(bounds.report).length) {
    focus_reset();
  }
}

/**
 * Reset the camera to the default Taiwan bounds. Passing `isBtn` (the React nav
 * button click path) also clears the auto-focus lock, mirroring the old button
 * handler that re-enabled auto-focus.
 */
export function focus_reset(isBtn?: boolean): void {
  const config = getConfig();
  if (config["check-box"]["graphics-block-auto-zoom"] && !isBtn) {
    return;
  }

  if (isBtn) {
    setLock(false);
  }

  if (!variable.map) return;
  const phone = phonePadding();
  fitBounds(variable.map, MAP.BOUNDS, phone ? { ...MAP.OPTIONS, padding: phone } : MAP.OPTIONS);
}

/**
 * `map.fitBounds`, unless the camera is already where it would go.
 *
 * MapLibre animates even a move of zero length: a `fitBounds` to the current
 * camera still runs its whole `duration`, redrawing the map every frame. It was
 * called on every RTS frame while a report was on screen and every three
 * seconds while focusing, which kept the map rendering for half of each idle
 * second. `fitBounds` only ever changes centre, zoom and bearing — padding is
 * folded into those by `cameraForBounds` — so when all three are already there,
 * skipping it leaves the screen exactly as it was. The tolerances are far below
 * a pixel; they only absorb the rounding an animation's last frame leaves.
 */
function fitBounds(map: MlMap, bounds: LngLatBoundsLike, options: FitBoundsOptions): void {
  if (!map.isMoving()) {
    const target = map.cameraForBounds(bounds, options);
    if (target?.center !== undefined && target.zoom !== undefined) {
      const center = map.getCenter();
      const want = maplibregl.LngLat.convert(target.center);
      if (
        Math.abs(map.getZoom() - target.zoom) < 1e-6 &&
        Math.abs(center.lng - want.lng) < 1e-9 &&
        Math.abs(center.lat - want.lat) < 1e-9 &&
        map.getBearing() === (target.bearing ?? 0)
      ) {
        return;
      }
    }
  }
  map.fitBounds(bounds, options);
}

/**
 * On a phone held upright the map is the top of the screen, under the EEW
 * card and nothing else: a fit clears the card, and little more.
 */
function phonePadding(): { top: number; bottom: number; left: number; right: number } | null {
  if (!window.matchMedia("(max-width: 640px)").matches) return null;
  const card = document.querySelector(".legacy-eew-panel:not(.is-pip)")?.getBoundingClientRect();
  return { top: Math.round((card?.bottom ?? 0) + 12), bottom: 16, left: 16, right: 16 };
}

/**
 * The padding a fit keeps clear on each side: 150 px on a desktop, less on a
 * phone, where 150 on both sides would leave the map no room at all.
 */
function defaultPadding(): { top: number; bottom: number; left: number; right: number } {
  const phone = phonePadding();
  if (phone) return phone;
  if (window.matchMedia("(max-height: 500px)").matches) return { top: 30, bottom: 30, left: 150, right: 60 };
  return { top: 150, bottom: 150, left: 150, right: 150 };
}

/** Fit the map to the given coordinates with padded framing. */
export function updateMapBounds(coordinates: Coord[], options: FitOptions = {}): void {
  const bounds = new maplibregl.LngLatBounds();

  coordinates.forEach((coord) => {
    bounds.extend([coord.lon, coord.lat]);
  });

  if (!variable.map) return;
  const pad = defaultPadding();
  fitBounds(variable.map, bounds, {
    padding: {
      top: options.paddingTop || pad.top,
      bottom: options.paddingBottom || pad.bottom,
      left: options.paddingLeft || pad.left,
      right: options.paddingRight || pad.right,
    },
    maxZoom: options.maxZoom || 8,
    duration: options.duration || 500,
  });
}
