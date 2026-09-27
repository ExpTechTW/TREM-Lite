// Ported from legacy/src/js/index/core/focus.js
import maplibregl, { type FitBoundsOptions, type LngLatBoundsLike, type Map as MlMap } from "maplibre-gl";

import { getConfig } from "@/lib/config";
import { MAP } from "@/lib/constants";
import { events } from "@/lib/events";
import { variable } from "@/lib/variable";

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

  // Manual pan (mousedown) / zoom (wheel) locks auto-focus so the camera stops
  // fighting the user, until they press the nav focus button to re-enable it.
  map.on("mousedown", () => {
    isMouseDown = true;
    setLock(true);
  });

  map.on("mouseup", () => {
    isMouseDown = false;
  });

  map.on("wheel", () => {
    setLock(true);
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
  // On a phone the panels take the top and bottom of the screen; Taiwan is
  // framed in what is left.
  const phone = window.matchMedia("(max-width: 640px)").matches;
  fitBounds(
    variable.map,
    MAP.BOUNDS,
    phone ? { ...MAP.OPTIONS, padding: { top: 210, bottom: 150, left: 8, right: 8 } } : MAP.OPTIONS,
  );
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
 * The padding a fit keeps clear on each side: 150 px on a desktop, less on a
 * phone, where 150 on both sides would leave the map no room at all. In phone
 * portrait the panels sit above and below the map, so that is where the room
 * goes.
 */
function defaultPadding(): { top: number; bottom: number; left: number; right: number } {
  if (window.matchMedia("(max-width: 640px)").matches) return { top: 150, bottom: 150, left: 24, right: 24 };
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
