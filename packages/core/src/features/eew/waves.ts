/**
 * P/S wavefronts, shared by the EEW rings (eew.ts) and the flashing rings of
 * the earthquakes the RTS feed lists (box.ts).
 */
import { EEWCalculator } from "@/domain/eewCalculator";
import type { TimeTable } from "@/domain/eewCalculator";
import timeBinUrl from "@/data/time.bin?url";
import { decodeTimeTable } from "@/lib/bindata";
import { http } from "@/lib/http";

// P/S travel-time table, loaded from the compact binary (scripts/encode-data.mjs
// + lib/bindata.ts) instead of inlining the 1 MB JSON into the bundle. Async —
// only needed once an EEW is active, which is long after startup.
let calculator: EEWCalculator | null = null;
void http
  .asset(timeBinUrl)
  .then((buf) => {
    calculator = new EEWCalculator(decodeTimeTable(buf) as TimeTable);
  })
  .catch(() => {});

/** The travel-time calculator, or null while its table is still loading. */
export function waveCalculator(): EEWCalculator | null {
  return calculator;
}

/** Vertices of a fully detailed wavefront. Coarser rings step through this table. */
const RING_STEPS = 256;
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
/** Web Mercator metres per pixel at zoom 0 on the equator. */
const M_PER_PX_Z0 = 156543.03392;

/**
 * The sine and cosine of every vertex's bearing, computed once.
 */
const BEARING_SIN: number[] = [];
const BEARING_COS: number[] = [];
for (let i = 0; i <= RING_STEPS; i++) {
  const rad = ((i * 360) / RING_STEPS) * RAD;
  BEARING_SIN.push(Math.sin(rad));
  BEARING_COS.push(Math.cos(rad));
}

function metersPerPixel(lat: number, zoom: number): number {
  return (M_PER_PX_Z0 * Math.cos(lat * RAD)) / 2 ** zoom;
}

/**
 * How far a ring must grow, in km, before it moves by a pixel at this zoom.
 * Less than that is the same picture.
 */
export function ringStepKm(lat: number, zoom: number): number {
  return metersPerPixel(lat, zoom) / 1000;
}

/** The one source an EEW's P and S rings are drawn from (eew.ts; cross.ts reads it). */
export const waveSource = (id: string) => `${id}-wave`;

/**
 * Build a great-circle polygon (km radius) around `center`.
 *
 * Bearings come from the table above. `sin φ2` is `a + b·cos θ` — the value
 * `asin` is given — so it is not computed again, and `b`, `cos φ1·sin δ`, is
 * also the factor of `sin θ` in the `atan2`. `zoom` drops vertices that
 * would land on the same pixel; each kept vertex is one of the 256.
 */
export function createCircleFeature(
  center: [number, number],
  radius: number,
  zoom = 12,
): GeoJSON.Feature<GeoJSON.Polygon> {
  const delta = radius / 6371;
  const phi1 = center[1] * RAD;
  const lambda1 = center[0] * RAD;
  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const sinDelta = Math.sin(delta);
  const cosDelta = Math.cos(delta);
  const a = sinPhi1 * cosDelta;
  const b = cosPhi1 * sinDelta;

  const mpp = metersPerPixel(center[1], zoom);
  const circumferencePx = mpp > 0 && radius > 0 ? (2 * Math.PI * radius * 1000) / mpp : RING_STEPS;
  const need = Math.max(16, Math.ceil(circumferencePx / 8));
  const stride = need >= RING_STEPS ? 1 : Math.max(1, Math.floor(RING_STEPS / need));

  const ring: number[][] = [];
  for (let i = 0; i <= RING_STEPS; i += stride) {
    const sinPhi2 = a + b * BEARING_COS[i];
    const phi2 = Math.asin(sinPhi2 > 1 ? 1 : sinPhi2 < -1 ? -1 : sinPhi2);
    const lambda2 = lambda1 + Math.atan2(BEARING_SIN[i] * b, cosDelta - sinPhi1 * sinPhi2);
    ring.push([lambda2 * DEG, phi2 * DEG]);
  }
  ring.push(ring[0]);

  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [ring],
    },
  };
}
