/**
 * The intensity.v1 feed (api/v3/trem/intensity/{unix seconds}) — the shake
 * reports in force at that second — in the shape the intensity features read.
 *
 *   [{"source":"core-tnn1","id":1790494393,"serial":2,"status":"final",
 *     "ts":1790494463840,"eq":[1790494393],"area":{"2":[970],"1":[972,973]}}]
 *
 * `id` identifies the shake cycle: the epoch second of the event that opened
 * it, on both nodes alike. The features treat a report's id as its time in
 * milliseconds (its age, the time shown in a notification), as the v2 feed's
 * was, so it is scaled here. `max` is not sent; it is the highest level in
 * `area`, which lists only levels 1 and up. `status` (issued / updated /
 * final) is passed on; a new `serial` is what marks an update.
 */
export interface IntensityReport {
  id: number;
  serial: number;
  status: string;
  max: number;
  area: Record<string, number[]>;
}

export function readIntensityV1(value: unknown): IntensityReport[] | null {
  if (!Array.isArray(value)) return null;
  const out: IntensityReport[] = [];
  for (const r of value as Record<string, unknown>[]) {
    if (!r || !Number.isFinite(r.id) || !Number.isFinite(r.serial)) continue;
    const area = (r.area && typeof r.area === "object" ? r.area : {}) as Record<string, number[]>;
    const levels = Object.keys(area).map(Number).filter(Number.isFinite);
    out.push({
      id: (r.id as number) * 1000,
      serial: r.serial as number,
      status: typeof r.status === "string" ? r.status : "",
      max: levels.length ? Math.max(...levels) : 0,
      area,
    });
  }
  return out;
}
