// Ported from legacy/src/js/index/core/resource.js
// Station metadata for the realtime (RTS) stream. Must be keyed by the SAME ids
// the RTS stream reports (decimal, e.g. 6732340) — that is `api/v1/trem/station`
// (JSON: { id: { net, info: [{code,lat,lon,time}], work } }). NOTE: the CSV at
// static.core/resource/station is a DIFFERENT station set (hex ids) and does NOT
// match the RTS ids, so it cannot be used here.
import { HTTP_TIMEOUT, URL as API_URL } from "@/lib/constants";
import { fetchData } from "@/lib/http";
import { createLogger } from "@/lib/logger";
import { mark } from "@/lib/perf";
import { variable } from "@/lib/variable";
import type { Station } from "@/lib/types";

const log = createLogger("station");

const MAX_RETRIES = 5;
let retryTimeout: ReturnType<typeof setTimeout> | null = null;
let retryCount = 0;

async function getStationInfo(): Promise<void> {
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }

  const host = API_URL.API[Math.floor(Math.random() * API_URL.API.length)];
  try {
    const res = await fetchData(`https://${host}/api/v1/trem/station`, HTTP_TIMEOUT.RESOURCE);
    if (res.ok) {
      variable.station = (await res.json()) as Record<string, Station>;
      localStorage.setItem("cache.station", JSON.stringify(variable.station));
      retryCount = 0;
      log.info("loaded", Object.keys(variable.station).length, "stations");
      mark("station-loaded");
      return;
    }
  } catch {
    /* fall through to retry */
  }

  if (retryCount < MAX_RETRIES) {
    retryCount++;
    retryTimeout = setTimeout(() => void getStationInfo(), 3000 * retryCount);
  } else {
    retryCount = 0;
  }
}

/** Load station metadata now and every 10 minutes. */
export function initResource(): void {
  const cached = localStorage.getItem("cache.station");
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as Record<string, Station>;
      // Guard against a stale cache from the old CSV endpoint (wrong id scheme).
      const first = Object.values(parsed)[0];
      if (first && Array.isArray(first.info)) variable.station = parsed;
    } catch {
      /* ignore */
    }
  }
  void getStationInfo();
  setInterval(() => void getStationInfo(), 600000);
}
