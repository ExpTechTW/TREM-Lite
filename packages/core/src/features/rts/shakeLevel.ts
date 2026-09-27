/**
 * The shake level — rts-image-go's ShakeLevel (internal/intensity/
 * shakelevel.go, shared with palert-core): an earthquake's impact, range ×
 * severity, from each station's 計測震度, whatever the station density.
 *
 * Stations are binned into a 0.05° grid (about 5.5 km); each cell keeps its
 * strongest intensity, and every cell above 計測震度 0 adds (I − 0)^1.5. The sum
 * is scaled by 1.4, so quiet times score 0 and a quake felt island-wide about
 * 2000. A dense city thus scores no more than a sparsely instrumented county
 * shaking just as hard.
 *
 * `i` is the rts.v1 feed's, which is not floored at 0: sub-felt noise is
 * negative and adds nothing.
 */
const CELL = 0.05;
const I0 = 0;
const GAMMA = 1.5;
const K = 1.4;

export interface ShakePoint {
  lon: number;
  lat: number;
  i: number;
}

export function shakeLevel(points: Iterable<ShakePoint>): number {
  const grid = new Map<string, number>();
  for (const p of points) {
    if (Number.isNaN(p.i)) continue;
    const cell = `${Math.floor(p.lon / CELL)},${Math.floor(p.lat / CELL)}`;
    const strongest = grid.get(cell);
    if (strongest === undefined || p.i > strongest) grid.set(cell, p.i);
  }
  let sum = 0;
  for (const i of grid.values()) {
    const d = i - I0;
    if (d > 0) sum += d ** GAMMA;
  }
  return Math.round(K * sum);
}
