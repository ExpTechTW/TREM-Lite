/**
 * Seismology math — P/S wave travel distance from the depth time-table.
 *
 * The town-level intensity attenuation (`eewAreaPga`) now runs natively in Rust
 * (src-tauri/src/math.rs, wrapped by src/domain/eewMath.ts). The JS port of it
 * plus several never-wired helpers (eewAreaPgv, distance, p/sWaveTimeByDistance,
 * calculateWaveTime, pga↔intensity conversions, intensityToNumberString) were
 * removed as dead code — `psWaveDist` (which drives the EEW P/S wavefront rings)
 * is the only live consumer.
 */
export interface TimeTableRow {
  P: number;
  S: number;
  R: number;
  D: number;
}
export type TimeTable = Record<string, TimeTableRow[]>;

export interface PsWaveDist {
  p_dist: number;
  s_dist: number;
  s_t: number;
}

export class EEWCalculator {
  private timeTable: TimeTable;
  /** The table's depths, in `Object.keys` order — which decides ties below. */
  private depths: number[];

  constructor(timeTable: TimeTable) {
    this.timeTable = timeTable;
    // Once, rather than on every call (every 100 ms per active EEW).
    this.depths = Object.keys(timeTable).map(Number);
  }

  /** Interpolate the P/S wavefront radii (km) reached `now - time` after origin. */
  psWaveDist(depth: number, time: number, now: number): PsWaveDist {
    let pDist = 0;
    let sDist = 0;
    let sT = 0;

    const t = (now - time) / 1000.0;

    const depthKey = this.findClosest(this.depths, depth).toString();

    const timeTable = this.timeTable[depthKey];
    let prevTable: TimeTableRow | null = null;

    for (const table of timeTable) {
      if (pDist === 0 && table.P > t) {
        if (prevTable) {
          const tDiff = table.P - prevTable.P;
          const rDiff = table.R - prevTable.R;
          const tOffset = t - prevTable.P;
          const rOffset = (tOffset / tDiff) * rDiff;
          pDist = prevTable.R + rOffset;
        } else {
          pDist = table.R;
        }
      }

      if (sDist === 0 && table.S > t) {
        if (prevTable) {
          const tDiff = table.S - prevTable.S;
          const rDiff = table.R - prevTable.R;
          const tOffset = t - prevTable.S;
          const rOffset = (tOffset / tDiff) * rDiff;
          sDist = prevTable.R + rOffset;
        } else {
          sDist = table.R;
          sT = table.S;
        }
      }

      if (pDist !== 0 && sDist !== 0) {
        break;
      }
      prevTable = table;
    }

    if (pDist < 0) pDist = 0;
    if (sDist < 0) sDist = 0;

    return { p_dist: pDist, s_dist: sDist, s_t: sT };
  }

  private findClosest(arr: number[], target: number): number {
    return arr.reduce((prev, curr) =>
      Math.abs(curr - target) < Math.abs(prev - target) ? curr : prev,
    );
  }
}
