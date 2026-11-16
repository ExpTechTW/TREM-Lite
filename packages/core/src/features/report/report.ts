// Ported from legacy/src/js/index/core/report.js
// The scrollable list UI moves to a React overlay (overlays/ReportPanel.tsx);
// this module keeps the data fetching, map points, and lifecycle events.
import { openUrl as openExternal } from "@tauri-apps/plugin-opener";

import { getConfig, idleMap, onConfigUpdated } from "@/lib/config";
import { REPORT_LIMIT, HTTP_TIMEOUT, SHOW_REPORT } from "@/lib/constants";
import { HOST } from "@/lib/endpoints";
import { events } from "@/lib/events";
import { setFeatures } from "@/lib/mapSource";
import { fetchJson, http } from "@/lib/http";
import { createLogger } from "@/lib/logger";
import { now } from "@/lib/ntp";
import { mark } from "@/lib/perf";
import { eventHoldsMap, variable } from "@/lib/variable";
import type { ReportListItem } from "@/lib/types";
import { inTauri } from "@/lib/env";

import { isAutoFocusLocked, updateMapBounds } from "@/features/focus/focus";
import { startReplay, stopReplay } from "@/features/replay/replay";

import { ReportBook, type ReportChange } from "./reportBook";

let mapInitialized = false;
let started = false;
let activeReplayReportId: string | null = null;
let replayStateEpoch = 0;

const log = createLogger("report");

/**
 * How the list is kept current: the whole list once at start, then the live
 * stream's eq.report.v1 messages (relayed by data.ts as DataReport). The
 * stream does not replay what was issued before a connection, so the list is
 * fetched again each time one comes up (DataStreamUp) — the first one too,
 * since the start's fetch can be well before it. No timer polls it.
 *
 * Which reports are new, revised or already seen is reportBook.ts's: by id
 * and earthquake, not md5, and only one under 48 h old is announced.
 */
const SEEN_LIMIT = 200;
const FRESH_MS = 48 * 60 * 60 * 1000;
const REPORT_CACHE_KEY = "cache.report"; // 上次的報告列表，供冷啟動秒開
/** The HTTP list's own default `minIntensity`: unfelt reports are not on it. */
const MIN_INT = 1;

const book = new ReportBook({ limit: REPORT_LIMIT, seenLimit: SEEN_LIMIT, freshMs: FRESH_MS, minInt: MIN_INT });

/** A report list's body, verbatim, or null on any failure. */
async function getReportListText(url: string): Promise<string | null> {
  try {
    const res = await http.request(url, { timeout: HTTP_TIMEOUT.REPORT });
    if (!res.ok) log.warn(`地震報告取得失敗（HTTP ${res.status}）：${url}`);
    return res.ok ? await res.text() : null;
  } catch (e) {
    log.warn(`地震報告取得失敗：${url}`, e);
    return null;
  }
}

const listUrl = () => `https://${HOST.coreApi}/api/v2/eq/report?limit=${REPORT_LIMIT}`;

/** The list `refresh` last acted on, verbatim. */
let lastListText = "";
/**
 * Set by a replay. The stream is closed while one runs, so reports issued
 * meanwhile come with the next list fetched after it: they are remembered
 * without being announced, as they were when the list was polled through a
 * replay.
 */
let quietNextList = false;

async function getReportById(id: string): Promise<ReportListItem | null> {
  return fetchJson<ReportListItem>(`https://${HOST.coreApi}/api/v2/eq/report/${id}`, HTTP_TIMEOUT.REPORT);
}

function reportList(): ReportListItem[] {
  return variable.data.report as ReportListItem[];
}

/**
 * Replay hides reports that had not happened yet, but the report used to start
 * the replay is five seconds newer than replay.start_time. Keep that one row in
 * the list so its yellow replay frame does not disappear on the next poll.
 */
function visibleReportList(list: ReportListItem[]): ReportListItem[] {
  if (!variable.replay.start_time) return list;
  return list.filter(
    (item) =>
      item.time < variable.replay.start_time || item.id === activeReplayReportId,
  );
}

function applyVisibleReportList(list: ReportListItem[]): void {
  variable.data.report = visibleReportList(list) as never[];
}

function initializeMapLayers() {
  const map = variable.map;
  if (!map || map.getSource("report-markers-geojson")) return;

  map.addSource("report-markers-geojson", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "report-markers",
    type: "symbol",
    source: "report-markers-geojson",
    filter: ["!=", ["get", "i"], 0],
    layout: {
      "symbol-sort-key": ["get", "i"],
      "symbol-z-order": "source",
      "icon-image": [
        "match",
        ["get", "i"],
        1, "intensity-1",
        2, "intensity-2",
        3, "intensity-3",
        4, "intensity-4",
        5, "intensity-5",
        6, "intensity-6",
        7, "intensity-7",
        8, "intensity-8",
        9, "intensity-9",
        "cross",
      ],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 5, 0.2, 10, 0.6],
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  });

  map.addLayer({
    id: "report-markers-cross",
    type: "symbol",
    source: "report-markers-geojson",
    filter: ["==", ["get", "i"], 0],
    layout: {
      "symbol-sort-key": ["get", "i"],
      "symbol-z-order": "source",
      "icon-image": "cross",
      "icon-size": ["interpolate", ["linear"], ["zoom"], 5, 0.01, 10, 0.09],
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  });
}

/** The report object currently drawn. The same object every RTS frame is not redrawn. */
let plottedReport: ReportListItem | null = null;
/** Camera position the report was last fitted to. Empty while a fit is still moving. */
let fittedAt = "";

function cameraKey(): string {
  const map = variable.map;
  if (!map) return "";
  const c = map.getCenter();
  return `${map.getZoom().toFixed(4)}|${c.lng.toFixed(4)}|${c.lat.toFixed(4)}`;
}

/** Fit the report, unless the camera is already there or already on its way. */
function fitReport(): void {
  if (getConfig()["check-box"]["graphics-block-auto-zoom"]) return;

  const map = variable.map;
  if (!map || map.isMoving()) return;
  const key = cameraKey();
  if (key === fittedAt) return;
  updateMapBounds(variable.cache.bounds.report as never);
  fittedAt = map.isMoving() ? "" : cameraKey();
}

/** The report markers were cleared; the next showReportPoint must draw them again. */
export function forgetReportPoint(): void {
  plottedReport = null;
  fittedAt = "";
}

/** A report is the one currently drawn. Used to skip clearing an empty source. */
export function reportPointShown(): boolean {
  return plottedReport !== null;
}

/** Plot a report's town-level intensity points + epicenter cross. */
export function showReportPoint(data: ReportListItem | null): void {
  if (!data || !variable.map) return;
  const map = variable.map;

  // Idle calls this on every station frame with the same report. The points
  // are already on the map; fitting again is a no-op once the camera is there
  // (see fitBounds), and rebuilding the features only to throw them away is not.
  if (data === plottedReport) {
    if (!isAutoFocusLocked()) fitReport();
    return;
  }

  const features: GeoJSON.Feature[] = [];
  variable.cache.bounds.report = [];

  for (const city of Object.keys(data.list ?? {})) {
    const towns = data.list![city].town;
    for (const town of Object.keys(towns)) {
      const info = towns[town];
      variable.cache.bounds.report.push({ lon: info.lon, lat: info.lat } as never);
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [info.lon, info.lat] },
        properties: { i: info.int },
      });
    }
  }

  features.push({
    type: "Feature",
    geometry: { type: "Point", coordinates: [data.lon, data.lat] },
    properties: { i: 0 },
  });

  plottedReport = data;
  fittedAt = "";
  fitReport();
  setFeatures(map, "report-markers-geojson", features);
}

/** The panel's rows, and the copy kept for the next cold start. */
function publishList(): void {
  // Keep the full list separate from the replay-filtered panel. Persisting
  // the filtered list used to discard newer reports from the cold-start cache
  // and made them look newly released after replay ended.
  applyVisibleReportList(book.list);
  // 立即通知面板刷新，讓列表一載入就顯示（不必等 ReportPanel 的輪詢 tick）。
  events.emit("ReportListUpdate");
  // 寫入快取，供下次冷啟動秒開。
  try {
    localStorage.setItem(REPORT_CACHE_KEY, JSON.stringify(book.list));
  } catch {
    /* 配額滿等情況忽略 */
  }
}

/**
 * Announce a new or revised report, with its town intensities (the detail).
 * One issued a moment ago may not be stored yet (404 until then); the
 * stream's own copy, when there is one, carries them too.
 */
async function release(change: ReportChange, fallback: ReportListItem | null = null): Promise<void> {
  if (!SHOW_REPORT) return;
  const detailEpoch = replayStateEpoch;
  const detail = (await getReportById(change.report.id)) ?? fallback;
  if (detail && detailEpoch === replayStateEpoch && !variable.replay.start_time) {
    events.emit("ReportRelease", { data: detail, update: change.update });
  }
}

/**
 * A report shown from its realtime copy (the stream's first message) is now
 * stored: show the stored version, whose station list may differ.
 */
async function adoptStored(id: string): Promise<void> {
  const shown = () => (variable.cache.last_report as ReportListItem | null)?.id === id;
  if (!SHOW_REPORT || variable.play_mode !== 0 || !shown()) return;
  const detail = await getReportById(id);
  if (!detail || !shown() || variable.play_mode !== 0) return;
  variable.cache.last_report = detail;
  // Redrawn by the RTS handler, which shows the report only while the map
  // is not taken by an alert.
  events.emit("DataRts", { info: { type: variable.play_mode }, data: variable.data.rts });
}

function logChange(c: ReportChange, via: string): void {
  // Named in the log, so the next "why did this report pop up" has an answer.
  const r = c.report;
  log.info(
    `${c.update ? "報告修正" : "新報告"} ${r.id}｜${r.loc} M${r.mag} 深 ${r.depth} km（${via}）${c.fresh ? "" : "｜發震超過 48 小時，不發布"}`,
  );
}

/** Fetch the whole list: at start, and each time the live stream connects. */
async function refresh(why: string) {
  const text = await getReportListText(listUrl());
  if (text === null) return;
  const quiet = quietNextList && !variable.replay.start_time;
  if (quiet) quietNextList = false;

  // An unchanged list is the usual answer — the proxy revalidates it with an
  // ETag and the server says 304 — and nothing below does anything with one:
  // the panel gets the rows it already shows, the cache the bytes it already
  // holds, and every id in it has been seen. Stopping here skips re-parsing
  // the list, re-rendering its rows and re-writing localStorage.
  if (book.seeded && text === lastListText) return;

  let list: ReportListItem[] | null;
  try {
    list = JSON.parse(text) as ReportListItem[] | null;
  } catch {
    list = null;
  }
  if (!Array.isArray(list)) return;
  lastListText = text;
  const { first, changes, confirmed } = book.applyList(list, now());
  // 首次載入用 info（里程碑）；之後的更新降為 debug，避免洗版日誌檔。
  if (first) log.info(`報告列表首次載入（${why}），共 ${list.length} 筆`);
  else log.debug(`報告列表有變動（${why}），共 ${list.length} 筆`);
  mark("report-loaded");
  publishList();

  // The first list only seeds what has been seen: no report event.
  if (first) {
    // Seed the idle map with the most recent quake's shaking points (legacy sets
    // cache.last_report on first load WITHOUT emitting ReportRelease). Without
    // this, the idle RTS handler clears the live station dots and has no report
    // point to fall back to → a completely blank map ("沒有點").
    // last_report 仍要留下，之後從「即時測站」切回「地震報告」才有得畫。
    // 閒置選了即時測站時不畫上地圖；地震進行中仍畫，跟以前一樣。
    const newestVisibleReport = visibleReportList(book.list)[0];
    if (SHOW_REPORT && newestVisibleReport) {
      const detailEpoch = replayStateEpoch;
      const detail = await getReportById(newestVisibleReport.id);
      if (detail && detailEpoch === replayStateEpoch) {
        variable.cache.last_report = detail;
        if (idleMap() === "report" || eventHoldsMap()) showReportPoint(detail);
      }
    }
    return;
  }

  for (const id of confirmed) void adoptStored(id);
  for (const c of changes) logChange(c, why);
  if (quiet && changes.length) log.info(`重播期間發布的 ${changes.length} 筆報告只記下，不發布`);

  // Remember live arrivals while replaying so they do not become false "new"
  // reports afterwards, but never surface live report alerts in replay mode.
  if (variable.replay.start_time || quiet) return;

  const target = changes.find((c) => c.fresh); // list is newest-first
  if (target) await release(target);
}

/** An eq.report.v1 message from the live stream. */
function onStreamReport(message: { reason: number; data: unknown }): void {
  const result = book.applyStream(message, now());
  if (result.skipped) {
    const id = (message.data as { id?: unknown } | null)?.id;
    if (result.skipped === "invalid") log.warn(`即時報告訊息格式不對，略過：reason ${message.reason}`);
    else log.debug(`即時報告 ${String(id)} 略過：${result.skipped === "old-backfill" ? "維護回填的舊報告" : "全臺最大震度未達列表門檻"}`);
    return;
  }
  if (result.listChanged) publishList();
  if (result.confirmed) void adoptStored(result.detail!.id);
  const change = result.change;
  if (!change) return;
  logChange(change, `即時 reason ${message.reason}`);
  if (!change.fresh || variable.replay.start_time) return;
  void release(change, result.detail);
}

/**
 * An update being shown until its announcement ends. While it is set it is
 * `last_report`, so an RTS alert or EEW that takes the map over hands it back
 * to the update if it is still being read; after that, the latest report
 * returns.
 */
let updateOnShow: string | null = null;

async function endUpdate(id: string): Promise<void> {
  if (updateOnShow !== id) return; // a later report has taken over
  updateOnShow = null;
  const latest = book.list[0];
  if (!latest || latest.id === id) return; // the update is the latest report
  const detail = await getReportById(latest.id);
  if (!detail || updateOnShow !== null) return;
  variable.cache.last_report = detail;
  // Redrawn by the RTS handler, which shows the report only while the map
  // is not taken by an alert.
  events.emit("DataRts", { info: { type: variable.play_mode }, data: variable.data.rts });
}

function onReportRelease(ans: { data: ReportListItem; update?: boolean }) {
  updateOnShow = ans.update ? ans.data.id : null;
  if (SHOW_REPORT) {
    variable.cache.last_report = ans.data;
    // 閒置且改看即時測站時，新報告不蓋上地圖（列表照常）。
    // 地震進行中仍畫，下一幀 RTS 會清掉，跟以前一樣。
    if (idleMap() === "report" || eventHoldsMap()) showReportPoint(ans.data);
  }
  const data = ans.data;
  if (data.trem && Math.abs(data.trem - variable.cache.intensity.time) < 15000) {
    variable.cache.intensity.time = 0;
    variable.cache.intensity.max = 0;
  }
}

/** Open the CWA / TREM web page for a report. */
export function openReportUrl(item: ReportListItem): void {
  const reportId = item.id.replace(`-${item.id.split("-")[1]}`, "");
  const url = item.trem
    ? `https://api.exptech.dev/file/trem_info.html?id=${item.trem}`
    : `https://www.cwa.gov.tw/V8/C/E/EQ/EQ${reportId}.html`;
  if (inTauri) void openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

/** Toggle replay of a report's time window (mirrors the list replay button). */
export function replayReport(item: ReportListItem): void {
  const time = item.time - 5000;
  const wasActive = activeReplayReportId === item.id && variable.replay.start_time === time;
  stopReplay();
  if (!wasActive) startReplay(time, item.id);
}

export function getActiveReplayReportId(): string | null {
  return variable.replay.start_time ? activeReplayReportId : null;
}

export function getReports(): ReportListItem[] {
  return reportList();
}

/** Wire up report layers, the list fetch and the live stream's reports. */
export function initReport(): void {
  // 冷啟動先用上次快取立即顯示列表（fetch 完成會覆蓋為最新），避免等網路。
  try {
    const cached = localStorage.getItem(REPORT_CACHE_KEY);
    if (cached && !variable.data.report.length) {
      const list = JSON.parse(cached) as ReportListItem[];
      if (Array.isArray(list) && list.length) {
        book.restore(list);
        variable.data.report = list as never[];
        events.emit("ReportListUpdate");
      }
    }
  } catch {
    /* 壞快取忽略 */
  }

  // The report LIST is independent of the map — fetch it immediately so the
  // panel populates even if the basemap is slow to load (the live stream
  // waits for it). showReportPoint() safely no-ops until variable.map exists,
  // and the epicenter map layers are added when MapLoad fires.
  if (!started) {
    started = true;
    void refresh("啟動");
    events.on("DataStreamUp", () => void refresh("即時連線連上"));
    events.on("DataReport", (message) => onStreamReport(message));
  }
  events.on("MapLoad", () => {
    if (mapInitialized) return;
    mapInitialized = true;
    initializeMapLayers();
  });
  events.on("ReportRelease", (ans) => onReportRelease(ans));
  events.on("ReportSpeechEnd", ({ id }) => void endUpdate(id));

  // `config-updated` carries the whole config, so every other setting — the
  // volume, TTS — arrives here too. Only the toggle itself is worth acting on:
  // without the comparison, turning the volume down pulled the map back to the
  // report.
  let autoZoomEnabled = !getConfig()["check-box"]["graphics-block-auto-zoom"];
  void onConfigUpdated((next) => {
    const enabled = !next["check-box"]["graphics-block-auto-zoom"];
    if (enabled === autoZoomEnabled) return;
    autoZoomEnabled = enabled;
    if (enabled && plottedReport) fitReport();
  });

  events.on("ReplayStateChange", ({ active, reportId }) => {
    replayStateEpoch++;
    activeReplayReportId = active ? (reportId ?? null) : null;
    if (active) quietNextList = true;
    const source = book.list.length ? book.list : [...reportList()];
    applyVisibleReportList(source);
    events.emit("ReportListUpdate");
  });
}
