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
import { HTTP_TIMEOUT, URL as API_URL } from "@/lib/constants";
import { HOST } from "@/lib/endpoints";
import { fetchData } from "@/lib/http";
import { createLogger } from "@/lib/logger";
import { mark } from "@/lib/perf";
import { variable } from "@/lib/variable";
import type { Station } from "@/lib/types";

const log = createLogger("station");

/** localStorage keys. The legacy list keeps the key both lists once shared. */
export const STATION_CACHE_KEY = "cache.stations";
const LEGACY_CACHE_KEY = "cache.station";

const MAX_RETRIES = 5;
const REFRESH_MS = 600_000;

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

async function fetchStations(): Promise<Record<string, Station> | null> {
  const res = await fetchData(`https://${HOST.coreStatic}/resource/station`, HTTP_TIMEOUT.RESOURCE);
  return res.ok ? parseStationCsv(await res.text()) : null;
}

async function fetchLegacyStations(): Promise<Record<string, Station> | null> {
  const host = API_URL.API[Math.floor(Math.random() * API_URL.API.length)];
  const res = await fetchData(`https://${host}/api/v1/trem/station`, HTTP_TIMEOUT.RESOURCE);
  return res.ok ? ((await res.json()) as Record<string, Station>) : null;
}

/**
 * Load a list now and every 10 minutes, retrying a failure with backoff. A
 * failed or empty answer never replaces the list in hand.
 */
function keepFresh(
  name: string,
  fetcher: () => Promise<Record<string, Station> | null>,
  apply: (list: Record<string, Station>) => void,
): void {
  let retries = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const attempt = async () => {
    if (retry) clearTimeout(retry);
    retry = null;
    let list: Record<string, Station> | null = null;
    try {
      list = await fetcher();
    } catch {
      /* retried below */
    }
    if (list && Object.keys(list).length) {
      retries = 0;
      apply(list);
      log.info(`loaded ${Object.keys(list).length} ${name}`);
      return;
    }
    if (retries < MAX_RETRIES) {
      retries++;
      retry = setTimeout(() => void attempt(), 3000 * retries);
    } else {
      retries = 0;
    }
  };
  void attempt();
  setInterval(() => void attempt(), REFRESH_MS);
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
  log.info(`realtime station ${chosen} → ${nearest} (${best.toFixed(1)} km)`);
  void writeConfig({ ...config, "realtime-station-id": nearest });
}

/** Load both station lists now and every 10 minutes. */
export function initResource(): void {
  variable.station = readCache(STATION_CACHE_KEY);
  variable.legacyStation = readCache(LEGACY_CACHE_KEY);

  keepFresh("stations", fetchStations, (list) => {
    variable.station = list;
    localStorage.setItem(STATION_CACHE_KEY, JSON.stringify(list));
    mark("station-loaded");
    migrateRealtimeStation();
  });
  keepFresh("legacy stations", fetchLegacyStations, (list) => {
    variable.legacyStation = list;
    localStorage.setItem(LEGACY_CACHE_KEY, JSON.stringify(list));
    migrateRealtimeStation();
  });
}
