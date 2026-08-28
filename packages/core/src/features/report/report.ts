// Ported from legacy/src/js/index/core/report.js
// The scrollable list UI moves to a React overlay (features/report/ReportList.tsx);
// this module keeps the data fetching, map points, and lifecycle events.
import { openUrl as openExternal } from "@tauri-apps/plugin-opener";
import type { GeoJSONSource } from "maplibre-gl";

import { REPORT_LIMIT, HTTP_TIMEOUT, SHOW_REPORT } from "@/lib/constants";
import { url, reportFailure, reportSuccess } from "@/lib/endpoints";
import { events } from "@/lib/events";
import { fetchJson } from "@/lib/http";
import { createLogger } from "@/lib/logger";
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

// Reports come from a health-selected core node (never the DNS-balanced base,
// whose region drift caused false "new report" events). New reports are detected
// by md5; the hash list grows naturally and is capped at 200 (oldest evicted).
const MD5_LIMIT = 200;
const REPORT_CACHE_KEY = "cache.report"; // 上次的報告列表，供冷啟動秒開
const seenMd5 = new Set<string>();
const md5Order: string[] = [];

function rememberMd5(md5: string): void {
  if (seenMd5.has(md5)) return;
  seenMd5.add(md5);
  md5Order.push(md5);
  while (md5Order.length > MD5_LIMIT) {
    const oldest = md5Order.shift();
    if (oldest) seenMd5.delete(oldest);
  }
}

async function getReportList(limit: number): Promise<ReportListItem[] | null> {
  return fetchJson<ReportListItem[]>(
    url("coreApi", `/api/v2/eq/report?limit=${limit}`),
    HTTP_TIMEOUT.REPORT,
  );
}

async function getReportById(id: string): Promise<ReportListItem | null> {
  return fetchJson<ReportListItem>(url("coreApi", `/api/v2/eq/report/${id}`), HTTP_TIMEOUT.REPORT);
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
  const src = map.getSource("report-markers-geojson") as GeoJSONSource | undefined;
  src?.setData({ type: "FeatureCollection", features });
}

async function refresh() {
  const list = await getReportList(REPORT_LIMIT);
  if (!list) {
    reportFailure("coreApi");
    return;
  }
  reportSuccess("coreApi");
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

  // First (empty) load: seed the md5 hash list, DO NOT emit a report event.
  // Seed oldest→newest so the FIFO evicts genuinely-old reports first.
  if (!seeded) {
    seeded = true;
    [...list].reverse().forEach((r) => r.md5 && rememberMd5(r.md5));
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

  // Afterwards: a genuinely new md5 (robust to node switching) = a new report.
  const fresh = list.filter((r) => r.md5 && !seenMd5.has(r.md5));
  fresh.forEach((r) => r.md5 && rememberMd5(r.md5));

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
