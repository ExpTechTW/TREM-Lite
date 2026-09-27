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

/** The XML's level codes, JMA-style, back to the 0–9 levels (index). */
const LEVEL_CODES = ["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"];

/** InfoType back to the JSON feed's status. */
const STATUS: Record<string, string> = { 發表: "issued", 更新: "updated", 最終: "final", 取消: "cancel" };

/**
 * One shake report of the realtime stream's trem.intensity.v1 topic, which
 * the SSE server sends as TREM XML (sse-server-go trem_xml.md §2):
 *
 *   <Head><EventID>20260726203641</EventID><InfoType>發表</InfoType>
 *     <Serial>1</Serial>…</Head>
 *   <Body>…<Area level="2"><Town code="100"/>…</Area>…</Body>
 *
 * EventID is the shake id as YYYYMMDDHHMMSS in +08:00 — the same instant as
 * the v3 JSON's epoch seconds — so both come out with the same id.
 */
export function readIntensityXml(xml: string): IntensityReport | null {
  const head = xml.match(/<Head>([\s\S]*?)<\/Head>/)?.[1] ?? "";
  // The shake id, not one of the RelatedEewEvents that follow it.
  const stamp = head.replace(/<RelatedEewEvents>[\s\S]*?<\/RelatedEewEvents>/, "").match(/<EventID>(\d{14})<\/EventID>/)?.[1];
  const serial = Number(head.match(/<Serial>(\d+)<\/Serial>/)?.[1]);
  if (!stamp || !Number.isFinite(serial)) return null;
  const [y, mo, d, h, mi, s] = [0, 4, 6, 8, 10, 12].map((at, n) => Number(stamp.slice(at, n ? at + 2 : 4)));
  const id = Date.UTC(y, mo - 1, d, h - 8, mi, s);

  const area: Record<string, number[]> = {};
  for (const [, code, towns] of xml.matchAll(/<Area level="([^"]+)">([\s\S]*?)<\/Area>/g)) {
    const level = LEVEL_CODES.indexOf(code);
    if (level < 1) continue;
    area[level] = [...towns.matchAll(/<Town code="(\d+)"/g)].map((m) => Number(m[1]));
  }
  const levels = Object.keys(area).map(Number);
  const infoType = head.match(/<InfoType>([^<]*)<\/InfoType>/)?.[1] ?? "";
  return {
    id,
    serial,
    status: STATUS[infoType] ?? infoType,
    max: levels.length ? Math.max(...levels) : 0,
    area,
  };
}
