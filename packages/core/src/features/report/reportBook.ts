/**
 * The report list and which reports have been announced, kept from two
 * sources: the HTTP list (`GET /api/v2/eq/report?limit=N`, at start and after
 * every stream reconnect) and the live stream's eq.report.v1 messages in
 * between. Nothing here touches the network, the map or the clock, so it can
 * be tested alone; report.ts does those.
 *
 * The list stays what the HTTP list is — newest first, at most `limit` rows,
 * only reports felt somewhere (`int` ≥ `minInt`, the list's own default
 * filter) — with the stream's rows merged in. A row the stream brought and no
 * HTTP list has carried yet is kept across an HTTP list that lacks it: a
 * report's first message comes before it is stored, and a list fetched a
 * moment later need not have it.
 *
 * Each report is remembered by id, with what makes it that earthquake: origin
 * time, epicentre, depth and magnitude. An id not seen before is a new
 * report; a seen id whose earthquake has changed is an update (CWA revised
 * it). Not the list's md5: the server hashes the whole station list into it,
 * and the two core nodes stored different station lists for the 2026-08-25
 * 15:00 report — tyo1 kept a station CWA later removed — so every switch
 * between them released that report again. The ids are capped at `seenLimit`,
 * oldest evicted.
 *
 * A report's first stream message (reason 0) is CWA's realtime release; the
 * stored version follows (reason 1–3, and the HTTP list) with its coordinates
 * rounded to 2 decimals and the station list possibly different. So the first
 * stored version of a report known from reason 0 alone is compared loosely:
 * only a real change (another origin time, depth, magnitude, or an epicentre
 * moved further than rounding moves it) is an update.
 */
import type { ReportListItem } from "@/lib/types";

/** What identifies an earthquake (see the top of this file). */
interface Quake {
  time: number;
  lat: number;
  lon: number;
  depth: number;
  mag: number;
}

export interface ReportChange {
  report: ReportListItem;
  /** A report already seen whose earthquake changed. */
  update: boolean;
  /** Under `freshMs` old: the only kind announced. */
  fresh: boolean;
}

export interface BookOptions {
  /** Rows kept, as the HTTP list's `limit`. */
  limit: number;
  /** Ids remembered. */
  seenLimit: number;
  /** A report older than this is not announced (and its reason-3 resend is ignored). */
  freshMs: number;
  /** The lowest `int` the list holds: the HTTP list's own `minIntensity` (default 1). */
  minInt: number;
}

export interface ListResult {
  /** The first HTTP list: it only seeds what has been seen. */
  first: boolean;
  /** New and changed reports, newest first. Empty for the first list. */
  changes: ReportChange[];
  /** Ids known from reason 0 alone whose stored version has now arrived. */
  confirmed: string[];
}

export interface StreamResult {
  /** The list changed: a row added, replaced or moved. */
  listChanged: boolean;
  /** A new or revised report, or null. */
  change: ReportChange | null;
  /** The report as the stream sent it, with its town intensities. */
  detail: ReportListItem | null;
  /** Known from reason 0 alone until this message. */
  confirmed: boolean;
  /** Why the message changed nothing, when it was skipped outright. */
  skipped?: "invalid" | "old-backfill" | "unfelt";
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * A stream report's `data` as a list row (`row`, the fields the HTTP list
 * has, `int` taken from the highest county) and as the report itself
 * (`detail`, `row` plus its town intensities). Null when it is not a report.
 */
export function readStreamReport(data: unknown): { row: ReportListItem; detail: ReportListItem } | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.id !== "string" || !d.id) return null;
  if (!finite(d.time) || !finite(d.lat) || !finite(d.lon) || !finite(d.depth) || !finite(d.mag)) return null;
  const list = d.list && typeof d.list === "object" ? (d.list as NonNullable<ReportListItem["list"]>) : {};
  let int = 0;
  for (const county of Object.values(list)) {
    if (county && finite(county.int) && county.int > int) int = county.int;
  }
  const row: ReportListItem = {
    id: d.id,
    lat: d.lat,
    lon: d.lon,
    depth: d.depth,
    loc: typeof d.loc === "string" ? d.loc : "",
    mag: d.mag,
    time: d.time,
    int,
  };
  return { row, detail: { ...row, list } };
}

const quakeOf = (r: ReportListItem): Quake => ({ time: r.time, lat: r.lat, lon: r.lon, depth: r.depth, mag: r.mag });

const sameQuake = (a: Quake, b: Quake) =>
  a.time === b.time && a.lat === b.lat && a.lon === b.lon && a.depth === b.depth && a.mag === b.mag;

/**
 * The same earthquake once rounding is allowed for: the stored version rounds
 * the epicentre to 2 decimals (half a hundredth either way; a little more for
 * floating point). Depth and magnitude carry one decimal in both.
 */
const closeQuake = (a: Quake, b: Quake) =>
  Math.abs(a.time - b.time) < 1000 &&
  Math.abs(a.lat - b.lat) <= 0.0051 &&
  Math.abs(a.lon - b.lon) <= 0.0051 &&
  Math.abs(a.depth - b.depth) < 0.05 &&
  Math.abs(a.mag - b.mag) < 0.05;

const sameRow = (a: ReportListItem, b: ReportListItem) =>
  a.id === b.id &&
  a.time === b.time &&
  a.lat === b.lat &&
  a.lon === b.lon &&
  a.depth === b.depth &&
  a.mag === b.mag &&
  a.loc === b.loc &&
  a.int === b.int;

/** Where a row goes in a newest-first list: before the first one that is older. */
function insertAt(list: ReportListItem[], row: ReportListItem): number {
  const at = list.findIndex((r) => r.time < row.time);
  return at === -1 ? list.length : at;
}

export class ReportBook {
  /** The full list, newest first. */
  list: ReportListItem[] = [];
  /** An HTTP list has been applied. */
  seeded = false;

  private readonly seen = new Map<string, Quake>();
  /** Ids known from a reason-0 message alone. */
  private readonly provisional = new Set<string>();
  /** Rows from the stream that no HTTP list has carried yet. */
  private readonly streamed = new Map<string, ReportListItem>();

  constructor(private readonly opts: BookOptions) {}

  /** A list kept from the last run, shown until the first HTTP list. Nothing is remembered from it. */
  restore(list: ReportListItem[]): void {
    this.list = list.slice(0, this.opts.limit);
  }

  private remember(r: ReportListItem): void {
    this.seen.delete(r.id); // re-inserted last, so an update counts as recent
    this.seen.set(r.id, quakeOf(r));
    while (this.seen.size > this.opts.seenLimit) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  /** An HTTP list, newest first, as the server sent it. */
  applyList(rows: ReportListItem[], now: number): ListResult {
    const ids = new Set(rows.map((r) => r.id));
    const merged = rows.slice();
    for (const [id, row] of this.streamed) {
      if (ids.has(id)) this.streamed.delete(id);
      else merged.splice(insertAt(merged, row), 0, row);
    }
    merged.length = Math.min(merged.length, this.opts.limit);
    // Rows the stream brought that have fallen off the end are done with.
    const kept = new Set(merged.map((r) => r.id));
    for (const id of this.streamed.keys()) if (!kept.has(id)) this.streamed.delete(id);
    this.list = merged;

    const confirmed: string[] = [];
    if (!this.seeded) {
      this.seeded = true;
      // Oldest first, so the cap evicts genuinely old reports first.
      for (const r of [...rows].reverse()) {
        if (this.provisional.delete(r.id)) confirmed.push(r.id);
        this.remember(r);
      }
      return { first: true, changes: [], confirmed };
    }

    const changes: ReportChange[] = [];
    for (const r of rows) {
      const before = this.seen.get(r.id);
      const q = quakeOf(r);
      const wasProvisional = this.provisional.delete(r.id);
      if (before && wasProvisional) {
        confirmed.push(r.id);
        if (closeQuake(before, q)) {
          this.remember(r);
          continue;
        }
      } else if (before && sameQuake(before, q)) {
        continue;
      }
      this.remember(r);
      changes.push({ report: r, update: before !== undefined, fresh: now - r.time < this.opts.freshMs });
    }
    return { first: false, changes, confirmed };
  }

  /** One eq.report.v1 message. */
  applyStream(message: { reason: number; data: unknown }, now: number): StreamResult {
    const none = { listChanged: false, change: null, detail: null, confirmed: false };
    const read = readStreamReport(message.data);
    if (!read) return { ...none, skipped: "invalid" };
    const { row, detail } = read;
    // Mostly old reports sent again by monthly maintenance; a recent one
    // (one that was missed) is taken like any other.
    if (message.reason === 3 && now - row.time >= this.opts.freshMs) return { ...none, skipped: "old-backfill" };
    // Not on the list the HTTP API gives either.
    if ((row.int ?? 0) < this.opts.minInt) return { ...none, skipped: "unfelt" };

    // The list: replace the row, or put it in its place.
    let listChanged = false;
    const at = this.list.findIndex((r) => r.id === row.id);
    if (at === -1 || !sameRow(this.list[at], row)) {
      const list = this.list.slice();
      if (at !== -1) list.splice(at, 1);
      const to = insertAt(list, row);
      if (to < this.opts.limit) {
        list.splice(to, 0, row);
        list.length = Math.min(list.length, this.opts.limit);
        this.streamed.set(row.id, row);
        listChanged = true;
      } else if (at !== -1) {
        listChanged = true; // moved off the end
      }
      if (listChanged) this.list = list;
    }

    // Announced or not.
    const before = this.seen.get(row.id);
    const q = quakeOf(row);
    let confirmed = false;
    let update: boolean;
    if (!before) {
      update = false;
      if (message.reason === 0) this.provisional.add(row.id);
    } else if (message.reason === 0) {
      // Another realtime version: against the stored one only a real change counts.
      if (this.provisional.has(row.id) ? sameQuake(before, q) : closeQuake(before, q)) {
        return { listChanged, change: null, detail, confirmed };
      }
      update = true;
    } else if (this.provisional.delete(row.id)) {
      confirmed = true;
      if (closeQuake(before, q)) {
        this.remember(row);
        return { listChanged, change: null, detail, confirmed };
      }
      update = true;
    } else {
      if (sameQuake(before, q)) return { listChanged, change: null, detail, confirmed };
      update = true;
    }
    this.remember(row);
    return {
      listChanged,
      change: { report: row, update, fresh: now - row.time < this.opts.freshMs },
      detail,
      confirmed,
    };
  }
}
