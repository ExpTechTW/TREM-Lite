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
 * server. They are computed here instead, from the stations whose `alert` is
 * set — which the server does only for a station taking part in an earthquake
 * event it is tracking, so nothing further is filtered:
 *
 *   box  per detection box, the highest intensity level among the alerting
 *        stations inside it;
 *   int  per town (city + town), the highest `i` its alerting stations
 *        reported in the last 60 s, so a town does not drop off the list
 *        between two frames. Sorted highest first, as the v2 list was.
 *
 * v2's `I` (the intensity while triggered) is gone; `i` stands in for it.
 */
import { gunzipSync, strFromU8 } from "fflate";

import { intensity_float_to_int } from "@/domain/utils";
import type { RtsData, RtsStation } from "@/lib/types";

export interface RtsV1 {
  source?: string;
  ts?: number;
  stations?: Record<string, { i?: number; pga?: number; alert?: unknown }>;
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

const WINDOW_MS = 60_000;

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

export class RtsV1Reader {
  /** Per town, keyed city + town: its code and the samples still in the window. */
  private towns = new Map<string, { code: number; samples: { time: number; i: number }[] }>();

  constructor(private readonly lookups: RtsV1Lookups) {}

  /** Forget the window — at a live/replay boundary, where time jumps. */
  reset(): void {
    this.towns.clear();
  }

  read(payload: RtsV1): RtsData | null {
    if (!payload.stations) return null;
    const time = payload.ts ?? 0;
    const station: Record<string, RtsStation> = {};
    const box: Record<string, number> = {};

    for (const [id, s] of Object.entries(payload.stations)) {
      if (typeof s.i !== "number") continue;
      const alert = alerting(s.alert);
      // pga is omitted until a station's first measurement; 0 adds nothing to
      // the maxima and level sums that read it.
      station[id] = { i: s.i, pga: s.pga ?? 0, alert };
      if (!alert) continue;

      const at = this.lookups.station(id);
      if (!at) continue;
      const level = intensity_float_to_int(s.i);
      const boxId = this.lookups.boxOf(at.lon, at.lat);
      if (boxId !== null && (box[boxId] ?? -1) < level) box[boxId] = level;

      const name = this.lookups.townOf(at.code);
      if (!name) continue;
      const key = `${name.city}${name.town}`;
      let town = this.towns.get(key);
      if (!town) this.towns.set(key, (town = { code: at.code, samples: [] }));
      town.samples.push({ time, i: s.i });
    }

    return { station, box, int: this.int(time), time };
  }

  /** Each town's highest `i` in the window ending at `now`, as a level. */
  private int(now: number): RtsData["int"] {
    const peaks: { code: number; i: number }[] = [];
    for (const [key, town] of this.towns) {
      town.samples = town.samples.filter((s) => s.time <= now && now - s.time < WINDOW_MS);
      if (!town.samples.length) {
        this.towns.delete(key);
        continue;
      }
      peaks.push({ code: town.code, i: Math.max(...town.samples.map((s) => s.i)) });
    }
    return peaks.sort((a, b) => b.i - a.i).map((p) => ({ code: p.code, i: intensity_float_to_int(p.i) }));
  }
}
