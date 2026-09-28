// Station metadata. Two lists, because two station networks are in use:
//
// * static.core's resource/station — the hex device ids (e.g. 117825C) that
//   the rts.v1 stream and its v3 replay report. This is `variable.station`.
// * api/v1/trem/station — the decimal ids (e.g. 6732340) of the older
//   network, which the lpgm (long-period ground motion) reports still use.
//   This is `variable.legacyStation`.
//
// The two share no ids, so neither can stand in for the other.
import { distance } from "@/domain/utils";
import { getConfig, writeConfig } from "@/lib/config";
import { HTTP_TIMEOUT } from "@/lib/constants";
import { HOST } from "@/lib/endpoints";
import { fetchData } from "@/lib/http";
import { createLogger } from "@/lib/logger";
import { mark } from "@/lib/perf";
import { variable } from "@/lib/variable";
import type { Station } from "@/lib/types";

const log = createLogger("station");
/** Only api-1 serves the older list; api-2 and the lb/core nodes answer 404. */
const LEGACY_STATION_HOST = "api-1.exptech.dev";

/** localStorage keys. The legacy list keeps the key both lists once shared. */
export const STATION_CACHE_KEY = "cache.stations";
const LEGACY_CACHE_KEY = "cache.station";

/** How often each list is fetched; at start too. */
const REFRESH_MS = 300_000;

/**
 * The CSV at static.core/resource/station (served as application/json). Its
 * columns are found by header rather than by position:
 *
 *   loc_code,id,lat,lon,floor,code,net,time,work
 */
export function parseStationCsv(text: string): Record<string, Station> {
  const [header, ...rows] = text.trim().split(/\r?\n/);
  const cols = header.split(",").map((c) => c.trim());
  const col = (name: string) => cols.indexOf(name);
  const [ID, LAT, LON, CODE, NET, WORK] = ["id", "lat", "lon", "code", "net", "work"].map(col);
  if ([ID, LAT, LON, CODE].includes(-1)) return {};

  const out: Record<string, Station> = {};
  for (const row of rows) {
    const cell = row.split(",").map((c) => c.trim());
    const id = cell[ID];
    const lat = Number(cell[LAT]);
    const lon = Number(cell[LON]);
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out[id] = {
      info: [{ code: Number(cell[CODE]), lat, lon }],
      net: NET === -1 ? undefined : cell[NET],
      work: WORK === -1 ? undefined : cell[WORK] === "1",
    };
  }
  return out;
}

const STATIONS_URL = `https://${HOST.coreStatic}/resource/station`;
const LEGACY_STATIONS_URL = `https://${LEGACY_STATION_HOST}/api/v1/trem/station`;
const parseLegacy = (text: string) => JSON.parse(text) as Record<string, Station>;

/**
 * Keep a list current: fetched now and every REFRESH_MS. The HTTP layer
 * revalidates it with its ETag and retries a failure, so an unchanged list is
 * a 304 whose bytes match the last ones, and nothing more happens: no parse,
 * no localStorage write. A failed, empty or unreadable answer never replaces
 * the list in hand; the next round tries again.
 */
function keepFresh(
  name: string,
  url: string,
  parse: (text: string) => Record<string, Station>,
  apply: (list: Record<string, Station>, text: string) => void,
): void {
  let last = "";
  const fetchList = async () => {
    let text: string;
    try {
      const res = await fetchData(url, HTTP_TIMEOUT.RESOURCE);
      if (!res.ok) {
        log.warn(`${name} 取得失敗（HTTP ${res.status}），沿用現有的`);
        return;
      }
      text = await res.text();
    } catch (e) {
      log.warn(`${name} 取得失敗，沿用現有的：`, e);
      return;
    }
    if (text === last) return;
    let list: Record<string, Station>;
    try {
      list = parse(text);
    } catch (e) {
      log.warn(`${name} 解析失敗，沿用現有的：`, e);
      return;
    }
    if (!Object.keys(list).length) {
      log.warn(`${name} 上游回空表，沿用現有的`);
      return;
    }
    last = text;
    apply(list, text);
    log.info(`${name} 更新：${Object.keys(list).length} 站`);
  };
  void fetchList();
  setInterval(() => void fetchList(), REFRESH_MS);
}

function readCache(key: string): Record<string, Station> | null {
  try {
    const cached = localStorage.getItem(key);
    return cached ? (JSON.parse(cached) as Record<string, Station>) : null;
  } catch {
    return null;
  }
}

/**
 * The chosen realtime station, once written as a decimal id of the older
 * network, becomes the nearest station of the new one. Needs both lists: the
 * old id's position comes from the legacy list.
 */
function migrateRealtimeStation(): void {
  const stations = variable.station;
  if (!stations) return;
  const config = getConfig();
  // String(): YAML reads an all-digit hex id back as a number.
  const chosen = String(config["realtime-station-id"]);
  if (stations[chosen]) return;

  const old = variable.legacyStation?.[chosen]?.info.at(-1);
  if (!old) return; // wait for the legacy list, or an id neither list knows
  let nearest = "";
  let best = Infinity;
  for (const [id, station] of Object.entries(stations)) {
    const at = station.info.at(-1);
    if (!at) continue;
    const km = distance(old.lat, old.lon, at.lat, at.lon);
    if (km < best) {
      best = km;
      nearest = id;
    }
  }
  if (!nearest) return;
  log.info(`我的測站 ${chosen} 不在新的測站清單裡，改用最近的 ${nearest}（相距 ${best.toFixed(1)} km）`);
  void writeConfig({ ...config, "realtime-station-id": nearest });
}

/** Store a list for the next start; a full storage only costs that. */
function keep(key: string, list: Record<string, Station>): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* quota: the list is still in use, just not kept */
  }
}

/**
 * Both station lists: the last ones kept, at once, then fetched now and every
 * REFRESH_MS (keepFresh), each kept again whenever it changes.
 */
export function initResource(): void {
  variable.station = readCache(STATION_CACHE_KEY);
  variable.legacyStation = readCache(LEGACY_CACHE_KEY);

  keepFresh("測站清單", STATIONS_URL, parseStationCsv, (list) => {
    variable.station = list;
    keep(STATION_CACHE_KEY, list);
    mark("station-loaded");
    migrateRealtimeStation();
  });
  keepFresh("舊版測站清單", LEGACY_STATIONS_URL, parseLegacy, (list) => {
    variable.legacyStation = list;
    keep(LEGACY_CACHE_KEY, list);
    migrateRealtimeStation();
  });
}
