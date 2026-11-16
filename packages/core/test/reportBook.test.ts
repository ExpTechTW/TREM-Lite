import { describe, expect, test } from "bun:test";

import { ReportBook, readStreamReport } from "../src/features/report/reportBook";
import type { ReportListItem } from "../src/lib/types";

import { reportData } from "./fixtures";

const H = 3_600_000;
const NOW = 1794200000000;
const FRESH = 48 * H;

const book = (limit = 5) => new ReportBook({ limit, seenLimit: 200, freshMs: FRESH, minInt: 1 });

/** A row as the HTTP list has it. */
function row(n: number, over: Partial<ReportListItem> = {}): ReportListItem {
  return {
    id: `115${String(n).padStart(3, "0")}-2026-1109-0000${String(n).padStart(2, "0")}`,
    lat: 23 + n / 100,
    lon: 121 + n / 100,
    depth: 10,
    loc: `place ${n}`,
    mag: 4,
    time: NOW - (100 - n) * 60_000, // larger n is newer, all under 2 h old
    int: 2,
    trem: 0,
    md5: `MD5${n}`,
    ...over,
  };
}

/** Rows newest first, as the HTTP list sends them. */
const list = (...ns: number[]) => ns.sort((a, b) => b - a).map((n) => row(n));

/** A stream message's `data` for a row, with a county list giving its `int`. */
function streamed(r: ReportListItem, over: Partial<Record<string, unknown>> = {}) {
  return reportData({
    id: r.id,
    lat: r.lat,
    lon: r.lon,
    depth: r.depth,
    mag: r.mag,
    time: r.time,
    loc: r.loc,
    list: { 花蓮縣: { int: r.int ?? 2, town: { 花蓮市: { lat: 23.9, lon: 121.6, int: r.int ?? 2 } } } },
    ...over,
  });
}

const ids = (b: ReportBook) => b.list.map((r) => r.id);

describe("readStreamReport", () => {
  test("a row with the HTTP list's fields, int from the highest county", () => {
    const read = readStreamReport(reportData())!;
    expect(read.row).toEqual({
      id: "115079-2026-1109-122157",
      lat: 23.62,
      lon: 120.66,
      depth: 10.5,
      loc: "雲林縣政府東南東方  23.2  公里 (位於雲林縣古坑鄉)",
      mag: 4.2,
      time: 1794198117000,
      int: 3,
    });
    expect(read.detail.list).toEqual(reportData().list);
  });

  test("no county list is intensity 0; a report missing a field is nothing", () => {
    expect(readStreamReport(reportData({ list: {} }))!.row.int).toBe(0);
    expect(readStreamReport(reportData({ list: undefined }))!.row.int).toBe(0);
    expect(readStreamReport(reportData({ mag: "4.2" }))).toBeNull();
    expect(readStreamReport(reportData({ id: "" }))).toBeNull();
    expect(readStreamReport(null)).toBeNull();
  });
});

describe("startup list", () => {
  test("the first list only seeds", () => {
    const b = book();
    const r = b.applyList(list(1, 2, 3), NOW);
    expect(r).toEqual({ first: true, changes: [], confirmed: [] });
    expect(ids(b)).toEqual([row(3).id, row(2).id, row(1).id]);
    expect(b.seeded).toBe(true);
  });

  test("a cached list shows until then, and remembers nothing", () => {
    const b = book();
    b.restore(list(1, 2));
    expect(b.seeded).toBe(false);
    expect(ids(b)).toEqual([row(2).id, row(1).id]);
    expect(b.applyList(list(1, 2, 3), NOW).changes).toEqual([]);
  });
});

describe("stream messages", () => {
  test("a new report goes on top and is announced", () => {
    const b = book();
    b.applyList(list(1, 2, 3), NOW);
    const r = b.applyStream({ reason: 1, data: streamed(row(4)) }, NOW);
    expect(r.listChanged).toBe(true);
    expect(r.change).toEqual({ report: expect.objectContaining({ id: row(4).id, int: 2 }), update: false, fresh: true });
    expect(r.detail?.list).toBeDefined();
    expect(ids(b)[0]).toBe(row(4).id);
  });

  test("the same message again changes nothing", () => {
    const b = book();
    b.applyList(list(1, 2, 3), NOW);
    b.applyStream({ reason: 1, data: streamed(row(4)) }, NOW);
    const again = b.applyStream({ reason: 1, data: streamed(row(4)) }, NOW);
    expect(again.listChanged).toBe(false);
    expect(again.change).toBeNull();
    expect(ids(b).filter((id) => id === row(4).id)).toHaveLength(1);
  });

  test("a report already on the list, unchanged, is not announced", () => {
    const b = book();
    b.applyList(list(1, 2, 3), NOW);
    const r = b.applyStream({ reason: 2, data: streamed(row(3)) }, NOW);
    expect(r.change).toBeNull();
  });

  test("reason 0 then its stored version, rounded: one announcement, and the row replaced", () => {
    const b = book();
    b.applyList(list(1, 2, 3), NOW);
    const live = row(4, { lat: 23.6149, lon: 121.0351, loc: "realtime wording" });
    const first = b.applyStream({ reason: 0, data: streamed(live) }, NOW);
    expect(first.change?.update).toBe(false);

    const stored = row(4, { lat: 23.61, lon: 121.04, loc: "stored wording" });
    const second = b.applyStream({ reason: 1, data: streamed(stored) }, NOW);
    expect(second.change).toBeNull();
    expect(second.confirmed).toBe(true);
    expect(second.listChanged).toBe(true);
    expect(b.list[0]).toMatchObject({ lat: 23.61, lon: 121.04, loc: "stored wording" });

    // From here the stored version is the reference: exact again.
    const revised = b.applyStream({ reason: 2, data: streamed(row(4, { lat: 23.61, lon: 121.04, mag: 4.5 })) }, NOW);
    expect(revised.change?.update).toBe(true);
  });

  test("reason 0 then a stored version that really differs is an update", () => {
    const b = book();
    b.applyList(list(1), NOW);
    b.applyStream({ reason: 0, data: streamed(row(4)) }, NOW);
    const r = b.applyStream({ reason: 1, data: streamed(row(4, { mag: 4.4 })) }, NOW);
    expect(r.confirmed).toBe(true);
    expect(r.change?.update).toBe(true);
  });

  test("old reason-3 backfill is ignored; a recent one is taken", () => {
    const b = book();
    b.applyList(list(50, 60, 70), NOW);
    const old = row(1, { time: NOW - 30 * 24 * H });
    expect(b.applyStream({ reason: 3, data: streamed(old) }, NOW)).toMatchObject({
      skipped: "old-backfill",
      listChanged: false,
      change: null,
    });
    expect(ids(b)).not.toContain(old.id);

    const missed = row(99, { time: NOW - 2 * H });
    const r = b.applyStream({ reason: 3, data: streamed(missed) }, NOW);
    expect(r.change).toMatchObject({ update: false, fresh: true });
    // In its place by origin time: older than the three on the list.
    expect(ids(b)).toEqual([row(70).id, row(60).id, row(50).id, missed.id]);
  });

  test("an unfelt report is not on the list, as on the HTTP list", () => {
    const b = book();
    b.applyList(list(1, 2), NOW);
    const r = b.applyStream({ reason: 1, data: streamed(row(5), { list: {} }) }, NOW);
    expect(r.skipped).toBe("unfelt");
    expect(ids(b)).toHaveLength(2);
  });

  test("a message that is not a report", () => {
    const b = book();
    expect(b.applyStream({ reason: 1, data: { id: "x" } }, NOW).skipped).toBe("invalid");
  });

  test("newest first, and never longer than the limit", () => {
    const b = book(3);
    b.applyList(list(10, 20, 30), NOW);
    // Between 20 and 30.
    b.applyStream({ reason: 1, data: streamed(row(25)) }, NOW);
    expect(ids(b)).toEqual([row(30).id, row(25).id, row(20).id]);
    // Older than every row of a full list: not on it.
    const r = b.applyStream({ reason: 1, data: streamed(row(5)) }, NOW);
    expect(r.listChanged).toBe(false);
    expect(ids(b)).toEqual([row(30).id, row(25).id, row(20).id]);
  });

  test("before any HTTP list, a stream report is still new", () => {
    const b = book();
    expect(b.applyStream({ reason: 1, data: streamed(row(4)) }, NOW).change?.update).toBe(false);
    expect(b.applyList(list(1, 2, 3, 4), NOW)).toMatchObject({ first: true, changes: [] });
  });
});

describe("refill after a reconnect", () => {
  test("a report issued while disconnected is found, and announced once", () => {
    const b = book();
    b.applyList(list(1, 2, 3), NOW);
    const r = b.applyList(list(1, 2, 3, 4), NOW);
    expect(r.first).toBe(false);
    expect(r.changes).toEqual([{ report: row(4), update: false, fresh: true }]);
    // Then the stream sends it too (or the list comes again): nothing new.
    expect(b.applyStream({ reason: 1, data: streamed(row(4)) }, NOW).change).toBeNull();
    expect(b.applyList(list(1, 2, 3, 4), NOW).changes).toEqual([]);
  });

  test("a list that lacks a report the stream just brought keeps it", () => {
    const b = book();
    b.applyList(list(1, 2, 3), NOW);
    b.applyStream({ reason: 0, data: streamed(row(5)) }, NOW);
    const r = b.applyList(list(1, 2, 3, 4), NOW);
    expect(ids(b)).toEqual([row(5).id, row(4).id, row(3).id, row(2).id, row(1).id]);
    expect(r.changes.map((c) => c.report.id)).toEqual([row(4).id]);
  });

  test("once the list has it, the list's row wins; rounding of a reason-0 report is no update", () => {
    const b = book();
    b.applyList(list(1, 2, 3), NOW);
    b.applyStream({ reason: 0, data: streamed(row(5, { lat: 23.0549, loc: "realtime" })) }, NOW);
    const r = b.applyList(list(1, 2, 3, 5), NOW);
    expect(r.changes).toEqual([]);
    expect(r.confirmed).toEqual([row(5).id]);
    expect(b.list[0]).toEqual(row(5));
    // No longer held: a later list without it (it was deleted) drops it.
    b.applyList(list(1, 2, 3), NOW);
    expect(ids(b)).not.toContain(row(5).id);
  });

  test("a revision found by the refill is an update", () => {
    const b = book();
    b.applyList(list(1, 2, 3), NOW);
    const revised = [row(3, { mag: 4.6 }), row(2), row(1)];
    expect(b.applyList(revised, NOW).changes).toEqual([{ report: revised[0], update: true, fresh: true }]);
  });

  test("a report found late but over 48 h old is not fresh", () => {
    const b = book();
    b.applyList(list(1, 2, 3), NOW);
    const late = row(0, { time: NOW - 50 * H });
    const r = b.applyList([...list(1, 2, 3), late], NOW);
    expect(r.changes).toEqual([{ report: late, update: false, fresh: false }]);
  });

  test("stream rows that fall off the end are dropped", () => {
    const b = book(3);
    b.applyList(list(10, 20), NOW);
    b.applyStream({ reason: 0, data: streamed(row(15)) }, NOW);
    expect(ids(b)).toEqual([row(20).id, row(15).id, row(10).id]);
    b.applyList(list(10, 20, 30, 40), NOW);
    expect(ids(b)).toEqual([row(40).id, row(30).id, row(20).id]);
    // Gone for good, not held for the next list.
    b.applyList(list(20, 30, 40), NOW);
    expect(ids(b)).toEqual([row(40).id, row(30).id, row(20).id]);
  });
});
