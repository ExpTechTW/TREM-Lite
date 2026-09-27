// Ported from legacy/src/js/index/core/report.js
// The scrollable list UI moves to a React overlay (overlays/ReportPanel.tsx);
// this module keeps the data fetching, map points, and lifecycle events.
import { openUrl as openExternal } from "@tauri-apps/plugin-opener";

import { REPORT_LIMIT, HTTP_TIMEOUT, SHOW_REPORT } from "@/lib/constants";
import { HOST } from "@/lib/endpoints";
import { events } from "@/lib/events";
import { setFeatures } from "@/lib/mapSource";
import { fetchJson, http } from "@/lib/http";
import { createLogger } from "@/lib/logger";
import { now } from "@/lib/ntp";
import { mark } from "@/lib/perf";
import { variable } from "@/lib/variable";
import type { ReportListItem } from "@/lib/types";
import { inTauri } from "@/lib/env";

import { updateMapBounds } from "@/features/focus/focus";
import { startReplay, stopReplay } from "@/features/replay/replay";

let mapInitialized = false;
let refreshInterval: ReturnType<typeof setInterval> | null = null;
let activeReplayReportId: string | null = null;
let latestFullReportList: ReportListItem[] = [];
let replayStateEpoch = 0;
let seeded = false; // first (empty) fetch must NOT emit a report event

const log = createLogger("report");

// A new report is one whose id has not been seen, as in legacy report.js, and
// whose earthquake is less than an hour old. Not the list's md5: the two core
// nodes can disagree on it for the same report — tnn1 and tyo1 did for the
// 2026-08-25 15:00 report — so every switch between them released that report
// again. And not an old id either: a node whose list lags by one report ends
// its 150 one report further back, and that one was never seen. The id list is
// capped at 200 (oldest evicted).
const SEEN_LIMIT = 200;
const FRESH_MS = 60 * 60 * 1000;
const REPORT_CACHE_KEY = "cache.report"; // 上次的報告列表，供冷啟動秒開
const seenIds = new Set<string>();
const seenOrder: string[] = [];

function rememberId(id: string): void {
  if (seenIds.has(id)) return;
  seenIds.add(id);
  seenOrder.push(id);
  while (seenOrder.length > SEEN_LIMIT) {
    const oldest = seenOrder.shift();
    if (oldest) seenIds.delete(oldest);
  }
}

/** The report list's body, verbatim, or null on any failure. */
async function getReportListText(limit: number): Promise<string | null> {
  try {
    const res = await http.request(`https://${HOST.coreApi}/api/v2/eq/report?limit=${limit}`, {
      timeout: HTTP_TIMEOUT.REPORT,
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/** The list `refresh` last acted on, verbatim. */
let lastListText = "";

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

/** Plot a report's town-level intensity points + epicenter cross. */
export function showReportPoint(data: ReportListItem | null): void {
  if (!data || !variable.map) return;
  const map = variable.map;

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

  updateMapBounds(variable.cache.bounds.report as never);
  setFeatures(map, "report-markers-geojson", features);
}

async function refresh() {
  const text = await getReportListText(REPORT_LIMIT);

  // An unchanged list is the usual answer — the proxy revalidates it with an
  // ETag every ten seconds and the server says 304 — and nothing below does
  // anything with one: the panel gets the rows it already shows, the cache the
  // bytes it already holds, and every id in it has been seen. Stopping here
  // skips re-parsing 35 KB, re-rendering 150 rows and re-writing localStorage.
  if (seeded && text !== null && text === lastListText) return;

  let list: ReportListItem[] | null;
  try {
    list = text === null ? null : (JSON.parse(text) as ReportListItem[] | null);
  } catch {
    list = null;
  }
  if (!list) return;
  lastListText = text!;
  // 首次載入用 info（里程碑）；之後每 10s 的輪詢降為 debug，避免洗版日誌檔。
  if (seeded) log.debug("list", list.length);
  else log.info("list", list.length, "(initial)");
  mark("report-loaded");

  // Keep the live response separate from the replay-filtered panel. Persisting
  // the filtered list used to discard newer reports from the cold-start cache
  // and made them look newly released after replay ended.
  latestFullReportList = list;
  applyVisibleReportList(list);
  // 立即通知面板刷新，讓列表一載入就顯示（不必等 ReportPanel 的輪詢 tick）。
  events.emit("ReportListUpdate");
  // 寫入快取，供下次冷啟動秒開。
  try {
    localStorage.setItem(REPORT_CACHE_KEY, JSON.stringify(list));
  } catch {
    /* 配額滿等情況忽略 */
  }

  // First (empty) load: seed the seen ids, DO NOT emit a report event.
  // Seed oldest→newest so the FIFO evicts genuinely-old reports first.
  if (!seeded) {
    seeded = true;
    [...list].reverse().forEach((r) => rememberId(r.id));
    // Seed the idle map with the most recent quake's shaking points (legacy sets
    // cache.last_report on first load WITHOUT emitting ReportRelease). Without
    // this, the idle RTS handler clears the live station dots and has no report
    // point to fall back to → a completely blank map ("沒有點").
    const newestVisibleReport = visibleReportList(list)[0];
    if (SHOW_REPORT && newestVisibleReport) {
      const detailEpoch = replayStateEpoch;
      const detail = await getReportById(newestVisibleReport.id);
      if (detail && detailEpoch === replayStateEpoch) {
        variable.cache.last_report = detail;
        showReportPoint(detail); // no-op until the map is ready; DataRts re-plots
      }
    }
    return;
  }

  // Afterwards: an id never seen, for an earthquake under an hour old.
  const unseen = list.filter((r) => !seenIds.has(r.id));
  unseen.forEach((r) => rememberId(r.id));
  const fresh = unseen.filter((r) => now() - r.time < FRESH_MS);
  // Named in the log, so the next "why did this report pop up" has an answer.
  for (const r of unseen) {
    log.info(`${fresh.includes(r) ? "new" : "unseen but old, not released"}: ${r.id}`);
  }

  // Remember live arrivals while replaying so they do not become false "new"
  // reports afterwards, but never surface live report alerts in replay mode.
  if (variable.replay.start_time) return;

  const target = fresh[0]; // list is newest-first
  if (!target || !SHOW_REPORT) return;

  const detailEpoch = replayStateEpoch;
  const detail = await getReportById(target.id);
  if (detail && detailEpoch === replayStateEpoch && !variable.replay.start_time) {
    events.emit("ReportRelease", { data: detail });
  }
}

function onReportRelease(ans: { data: ReportListItem }) {
  if (SHOW_REPORT) {
    variable.cache.last_report = ans.data;
    showReportPoint(ans.data);
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

/** Wire up report layers + polling. */
export function initReport(): void {
  // 冷啟動先用上次快取立即顯示列表（fetch 完成會覆蓋為最新），避免等網路。
  try {
    const cached = localStorage.getItem(REPORT_CACHE_KEY);
    if (cached && !variable.data.report.length) {
      const list = JSON.parse(cached) as ReportListItem[];
      if (Array.isArray(list) && list.length) {
        latestFullReportList = list;
        variable.data.report = list as never[];
        events.emit("ReportListUpdate");
      }
    }
  } catch {
    /* 壞快取忽略 */
  }

  // The report LIST is independent of the map — poll immediately so the panel
  // populates even if the basemap is slow to load. showReportPoint() safely
  // no-ops until variable.map exists, and the epicenter map layers are added
  // when MapLoad fires.
  if (!refreshInterval) {
    refreshInterval = setInterval(() => void refresh(), 10000);
    void refresh();
  }
  events.on("MapLoad", () => {
    if (mapInitialized) return;
    mapInitialized = true;
    initializeMapLayers();
  });
  events.on("ReportRelease", (ans) => onReportRelease(ans));
  events.on("ReplayStateChange", ({ active, reportId }) => {
    replayStateEpoch++;
    activeReplayReportId = active ? (reportId ?? null) : null;
    const source = latestFullReportList.length ? latestFullReportList : [...reportList()];
    applyVisibleReportList(source);
    events.emit("ReportListUpdate");
  });
}
