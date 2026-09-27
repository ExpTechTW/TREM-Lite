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

/** Vertices per wavefront ring. */
const RING_STEPS = 256;

/**
 * The sine and cosine of every vertex's bearing, computed once with exactly the
 * expression the per-vertex loop used, so each value is bit-identical.
 */
const BEARING_SIN: number[] = [];
const BEARING_COS: number[] = [];
for (let i = 0; i <= RING_STEPS; i++) {
  const rad = (((i * 360) / RING_STEPS) * Math.PI) / 180;
  BEARING_SIN.push(Math.sin(rad));
  BEARING_COS.push(Math.cos(rad));
}

/**
 * Build a 256-point great-circle polygon (km radius) around `center`.
 *
 * Only the bearing changes from vertex to vertex, so everything else is
 * computed once per ring instead of 257 times. Every expression keeps the
 * grouping the per-vertex version had — `a + b·cos θ` is `sin φ1·cos δ +
 * (cos φ1·sin δ)·cos θ` — so every coordinate comes out bit-identical.
 */
export function createCircleFeature(center: [number, number], radius: number): GeoJSON.Feature<GeoJSON.Polygon> {
  const delta = radius / 6371;
  const phi1 = (center[1] * Math.PI) / 180;
  const lambda1 = (center[0] * Math.PI) / 180;
  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const sinDelta = Math.sin(delta);
  const cosDelta = Math.cos(delta);
  const a = sinPhi1 * cosDelta;
  const b = cosPhi1 * sinDelta;

  const ring: number[][] = [];
  for (let i = 0; i <= RING_STEPS; i++) {
    const phi2 = Math.asin(a + b * BEARING_COS[i]);
    const lambda2 =
      lambda1 + Math.atan2(BEARING_SIN[i] * sinDelta * cosPhi1, cosDelta - sinPhi1 * Math.sin(phi2));
    ring.push([(lambda2 * 180) / Math.PI, (phi2 * 180) / Math.PI]);
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
