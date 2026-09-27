/**
 * The rts.v1 feed — ExpTech's realtime station stream and its v3 replay
 * archive — turned into the RtsData every RTS feature already reads.
 *
 * rts.v1 carries each station's continuous intensity `i`, its peak `pga`, and
 * an `alert` flag, keyed by hex device id (the ids of static.core's station
 * list):
 *
 *   {"source":"core-tnn1","ts":1790487323000,
 *    "stations":{"117825C":{"i":-0.3,"pga":0.47,"alert":1}, …}}
 *
 * The v2 feed it replaces also carried `box` and `int`, computed on the
 * server. They are computed here instead, from this frame's stations whose
 * `alert` is set — which the server does only for a station taking part in an
 * earthquake event it is tracking, so nothing further is filtered:
 *
 *   box  per detection box, the highest intensity level among the alerting
 *        stations inside it;
 *   int  per town (city + town), the highest level among its alerting
 *        stations, sorted highest first, as the v2 list was.
 *
 * Both describe this frame alone. The bottom-right ranking holds each town's
 * peak for 60 s; that is its own (features/rts/townPeaks.ts), and nothing
 * else reads it.
 *
 * v2's `I` (the intensity while triggered) is gone; `i` stands in for it.
 *
 * rts.v1 also lists the earthquakes the server is tracking, each for 240 s
 * after its origin, as `eq`: [[lat, lon, depth km, origin unix s], …]. It is
 * passed on as is; box.ts draws their wavefronts in place of the boxes.
 */
import { gunzipSync, strFromU8 } from "fflate";

import { intensity_float_to_int } from "@/domain/utils";
import type { RtsData, RtsEq, RtsStation } from "@/lib/types";

export interface RtsV1 {
  source?: string;
  ts?: number;
  stations?: Record<string, { i?: number; pga?: number; alert?: unknown }>;
  eq?: unknown;
}

/** What the reader needs to know about the world, passed in so it can be tested alone. */
export interface RtsV1Lookups {
  /** A station's current position and town code, or null for an unknown id. */
  station: (id: string) => { lon: number; lat: number; code: number } | null;
  /** The detection box a point lies in, or null. */
  boxOf: (lon: number, lat: number) => number | null;
  /** A town code's city and town, or null. */
  townOf: (code: number) => { city: string; town: string } | null;
}

/**
 * An SSE data field of the rts.v1 stream: base64 of gzip of the JSON. A field
 * that is not — the `info` greeting, a plain-JSON archive — comes back as is.
 */
export function decodePayload(data: string): string {
  const compact = data.replace(/\s+/g, "");
  let bytes: Uint8Array;
  try {
    const binary = atob(compact);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return data;
  }
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return data;
  return strFromU8(gunzipSync(bytes));
}

/** The server writes `"alert":1`; other clients have been lenient about 1 vs "1". */
const alerting = (value: unknown) => value === 1 || value === "1" || value === true;

/** rts.v1's `eq`, keeping only entries of four finite numbers. */
function readEq(value: unknown): RtsEq[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is RtsEq => Array.isArray(e) && e.length >= 4 && e.slice(0, 4).every((n) => Number.isFinite(n)),
  );
}

export function readRtsV1(payload: RtsV1, lookups: RtsV1Lookups): RtsData | null {
  if (!payload.stations) return null;
  const station: Record<string, RtsStation> = {};
  const box: Record<string, number> = {};
  const towns = new Map<string, { code: number; level: number }>();

  for (const [id, s] of Object.entries(payload.stations)) {
    if (typeof s.i !== "number") continue;
    const alert = alerting(s.alert);
    // pga is omitted until a station's first measurement; 0 adds nothing to
    // the maxima and level sums that read it.
    station[id] = { i: s.i, pga: s.pga ?? 0, alert };
    if (!alert) continue;

    const at = lookups.station(id);
    if (!at) continue;
    const level = intensity_float_to_int(s.i);
    const boxId = lookups.boxOf(at.lon, at.lat);
    if (boxId !== null && (box[boxId] ?? -1) < level) box[boxId] = level;

    const name = lookups.townOf(at.code);
    if (!name) continue;
    const key = `${name.city}${name.town}`;
    const town = towns.get(key);
    if (!town || town.level < level) towns.set(key, { code: at.code, level });
  }

  const int = [...towns.values()].sort((a, b) => b.level - a.level).map((t) => ({ code: t.code, i: t.level }));
  return { station, box, int, time: payload.ts ?? 0, eq: readEq(payload.eq) };
}
