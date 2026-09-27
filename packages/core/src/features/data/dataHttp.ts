/**
 * SSE + multi-endpoint HTTP client — ported from legacy/src/js/index/data/http.js.
 *
 * Everything here is realtime: the SSE streams never end, and the polling path
 * (used by HTTP replay) asks for a different second each time. Both run with
 * `store: false` — an ETag could never match, and writing 1 Hz payloads into
 * the 250 MB LRU would evict the station/report/tile entries that do benefit
 * from it. They still go through `@/lib/http` so timeouts, gzip and transport
 * selection stay in one place.
 *
 * Two live streams, each connecting and reconnecting on its own:
 *
 *   trem  api/v1/trem/sse?topics=trem.intensity.v1,trem.rts.v1 — ExpTech's
 *         SSE server, one topic per named event, each frame base64(gzip(…)):
 *         rts.v1 as JSON (rtsV1.ts), intensity.v1 as TREM XML
 *         (intensityV1.ts). Both public, so no token. The server also carries
 *         trem.eew.v1, TREM's own EEW, which is not this app's business and is
 *         never asked for.
 *   eew   api/v2/eq/eew?sse=1 — public, plain JSON: the agencies' EEWs, of
 *         which the app shows CWA's (EEW_AUTHOR). The same path answers a
 *         plain GET with the current list; `sse=1` (or an Accept of
 *         text/event-stream, which is also sent) makes it the stream.
 *
 * `mode=live` asks for every RTS frame, about 2 Hz; without it the server
 * sends only frames with a triggered station (intensity is never filtered). While the main window is hidden the stream sleeps, as
 * trem-monitor does: the map is not seen, and an alert frame still arrives —
 * which is also what brings the window back. Switching is make-before-break:
 * the new connection opens, and the old one is closed once it is up.
 */

import { search_loc_name } from "@/domain/utils";
import { boxOf } from "@/features/box/polygons";
import { HTTP_TIMEOUT } from "@/lib/constants";
import { HOST, lbApiHost } from "@/lib/endpoints";
import { http, withController, type HttpResponse } from "@/lib/http";
import { createLogger } from "@/lib/logger";
import { mark } from "@/lib/perf";
import type { RtsData } from "@/lib/types";
import { variable } from "@/lib/variable";

import { readIntensityV1, readIntensityXml, type IntensityReport } from "./intensityV1";
import { decodePayload, readRtsV1, type RtsV1, type RtsV1Lookups } from "./rtsV1";

let sseController: AbortController | null = null;
let requestCounter = 0;
const activePollingControllers = new Set<AbortController>();

const log = createLogger("sse");
/** The lpgm archive is served only by api-1; the core nodes answer 401. */
const TREM_ARCHIVE_HOST = "api-1.exptech.dev";

/** Realtime payloads are never the same twice — keep them out of the LRU. */
const NO_STORE = { store: false } as const;

/**
 * The server comments `: ping` into every stream each 60 s. Silence for one
 * and a half of those means the connection is dead even if it looks open.
 */
const STALE_MS = 90_000;
/**
 * A connection is up once the server's `info` greeting arrives: the
 * subscription exists. Until then a handover keeps the connection it would
 * replace, and one that brings no greeting in this long is dropped — a hung
 * connect must not wait forever, nor hold two connections open.
 */
const READY_MS = 10_000;
/**
 * Reconnect delays double from `reconnectDelay` up to this. Kept short: the
 * eew stream is the early-warning path, and a node that comes back must not
 * sit unused for a minute.
 */
const BACKOFF_MAX_MS = 15_000;

const TOPICS = "trem.intensity.v1,trem.rts.v1";

const lookups: RtsV1Lookups = {
  station: (id) => {
    const at = variable.station?.[id]?.info.at(-1);
    return at ? { lon: at.lon, lat: at.lat, code: at.code } : null;
  },
  boxOf,
  townOf: search_loc_name,
};

export function abortAll(): void {
  if (sseController) {
    sseController.abort();
    sseController = null;
  }
  activePollingControllers.forEach((controller) => controller.abort());
  activePollingControllers.clear();
}

export interface SseHandlers {
  onRts?: (v: RtsData) => void;
  onEew?: (v: unknown) => void;
  onIntensity?: (v: IntensityReport[]) => void;
  reconnectDelay?: number;
  /** Start asleep: RTS alert frames only (see the top of this file). */
  background?: boolean;
}

export interface SseManager {
  abort: () => void;
  /** Sleep (true) or wake the trem stream, handing over to a new connection. */
  setBackground: (background: boolean) => void;
}

interface SseFrame {
  event?: string;
  data: string;
}

/** One SSE block. `:` comments (the server's `: ping`) carry no data. */
function parseFrame(block: string): SseFrame {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return { event, data: data.join("\n") };
}

/** Splits a byte stream into SSE frames, holding a partial one for the next chunk. */
function frameReader() {
  let buffer = "";
  const decoder = new TextDecoder();
  return (chunk: Uint8Array): SseFrame[] => {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, "");
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    return blocks.map(parseFrame);
  };
}

interface Stream {
  name: string;
  /** Read at every connection, so a reconnect or handover takes the current mode. */
  url: () => string;
  onFrame: (frame: SseFrame) => void;
}

/**
 * Keep one stream open until `signal` aborts, reconnecting with backoff.
 * `handover()` opens a second connection and closes the first once the new one
 * is up (READY_MS); should the new one fail first, the old one carries on and
 * the handover is tried again.
 */
function openStream(s: Stream, signal: AbortSignal, reconnectDelay: number): { handover: () => void } {
  let failures = 0;
  let frames = 0;
  /** The connection in use, and one taking over from it. */
  let active: AbortController | null = null;
  let pending: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const later = (handover: boolean) => {
    if (signal.aborted) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => connect(handover), Math.min(reconnectDelay * 2 ** failures, BACKOFF_MAX_MS));
    failures++;
  };

  function connect(handover: boolean) {
    if (signal.aborted) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    const attempt = new AbortController();
    if (handover && active && !active.signal.aborted) {
      pending?.abort();
      pending = attempt;
    } else {
      pending?.abort();
      pending = null;
      active?.abort();
      active = attempt;
    }
    const end = () => attempt.abort();
    signal.addEventListener("abort", end, { once: true });
    let stale: ReturnType<typeof setTimeout> | undefined;
    const alive = () => {
      clearTimeout(stale);
      stale = setTimeout(() => {
        log.warn(`${s.name}: nothing for ${STALE_MS / 1000} s → reconnect`);
        attempt.abort();
      }, STALE_MS);
    };
    let up = false;
    const notReady = setTimeout(() => {
      log.warn(`${s.name}: no greeting within ${READY_MS / 1000} s → drop`);
      attempt.abort();
    }, READY_MS);
    const url = s.url();

    http
      .stream(url, {
        signal: attempt.signal,
        headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
      })
      .then(async (res) => {
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        log.info(`${s.name} connected (${res.status}) ${url.replace(/^.*\?/, "?")}`);
        mark(`sse-${s.name}-connected`);
        alive();
        const reader = res.body.getReader();
        const split = frameReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) throw new Error("stream ended");
          alive();
          for (const frame of split(value)) {
            if (!frame.data && !frame.event) continue;
            if (!up) {
              up = true;
              clearTimeout(notReady);
              failures = 0;
              if (pending === attempt) {
                // Also drops a reconnect the replaced connection had asked for.
                if (retryTimer) clearTimeout(retryTimer);
                retryTimer = null;
                active?.abort();
                active = attempt;
                pending = null;
              }
            }
            if (frames++ % 40 === 0) log.debug(`${s.name} frame #${frames} (${frame.event ?? "message"})`);
            s.onFrame(frame);
          }
        }
      })
      .catch((e) => {
        // Entering replay aborts both streams on purpose, and a handover
        // closes the connection it replaced. Neither is a failure: no warning,
        // no reconnect. (Node health is the HTTP layer's; it ignores aborts too.)
        if (signal.aborted) return;
        if (pending === attempt && !up) {
          log.warn(`${s.name} handover failed → keeping the current connection`, e);
          pending = null;
          later(true);
          return;
        }
        if (attempt !== active) return;
        if (!attempt.signal.aborted) log.warn(`${s.name} error → reconnect`, e);
        later(false);
      })
      .finally(() => {
        clearTimeout(stale);
        clearTimeout(notReady);
        signal.removeEventListener("abort", end);
      });
  }

  connect(false);
  return { handover: () => connect(true) };
}

/** Open the live streams and dispatch parsed events. */
export function init(options: SseHandlers = {}): SseManager {
  const { onRts, onEew, onIntensity, reconnectDelay = 3000 } = options;
  let background = !!options.background;

  if (sseController) sseController.abort();
  const controller = new AbortController();
  sseController = controller;
  const { signal } = controller;

  const trem = openStream(
    {
      name: "trem",
      url: () => `https://${lbApiHost()}/api/v1/trem/sse?topics=${TOPICS}${background ? "" : "&mode=live"}`,
      onFrame: (frame) => {
        switch (frame.event) {
          case "info":
            // What the server granted, and what it left out and why.
            log.info(`trem greeting ${frame.data}`);
            return;
          case "trem.rts.v1": {
            let payload: RtsV1;
            try {
              payload = JSON.parse(decodePayload(frame.data)) as RtsV1;
            } catch {
              return; // not a frame this client understands
            }
            const rts = readRtsV1(payload, lookups);
            if (rts) onRts?.(rts);
            return;
          }
          case "trem.intensity.v1": {
            const report = readIntensityXml(decodePayload(frame.data));
            if (report) onIntensity?.([report]);
            return;
          }
          case "unsubscribed":
          case "close":
            log.warn(`trem ${frame.event}: ${frame.data}`);
            return;
          default:
            return; // a topic this client does not read
        }
      },
    },
    signal,
    reconnectDelay,
  );

  openStream(
    {
      name: "eew",
      url: () => `https://${lbApiHost()}/api/v2/eq/eew?sse=1`,
      onFrame: (frame) => {
        if (frame.event) {
          // The `info` greeting names the node that answered; EEWs come unnamed.
          if (frame.event === "info") log.info(`eew greeting ${frame.data}`);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(frame.data);
          if (parsed != null) onEew?.(parsed);
        } catch {
          /* skip invalid JSON */
        }
      },
    },
    signal,
    reconnectDelay,
  );

  return {
    abort: () => {
      controller.abort();
      if (sseController === controller) sseController = null;
    },
    setBackground: (value) => {
      if (value === background || signal.aborted) return;
      background = value;
      log.info(`trem → ${background ? "sleep (alert frames only)" : "live"}`);
      trem.handover();
    },
  };
}

export interface PolledData {
  rts: RtsData | null;
  eew: unknown[] | null;
  intensity: unknown[] | null;
  lpgm: unknown[] | null;
}

async function parseJson(response: HttpResponse | null): Promise<unknown | null> {
  if (!response?.ok) return null;
  try {
    return await response.json();
  } catch {
    // An intentional mode-transition abort may arrive after response headers
    // but while the body is still being consumed. Treat it as no data.
    return null;
  }
}

/**
 * HTTP polling — the transport of an HTTP replay, the one mode that polls: the
 * archives at the replay clock's second. RTS and intensity from the v3
 * archives (rts.v1, intensity.v1), EEW every call, intensity every 5th call,
 * lpgm every 7th.
 */
export async function getData(time: number): Promise<PolledData> {
  const suffix = `/${Math.round(time / 1000)}`;
  requestCounter++;
  const shouldFetchLPGM = requestCounter % 7 === 0;
  const shouldFetchIntensity = requestCounter % 5 === 0;

  const reqs = [
    withController(`https://${HOST.coreApi}/api/v3/trem/rts${suffix}`, HTTP_TIMEOUT.RTS, NO_STORE),
    withController(`https://${HOST.coreApi}/api/v2/eq/eew${suffix}`, HTTP_TIMEOUT.EEW, NO_STORE),
  ];
  if (shouldFetchIntensity) {
    reqs.push(withController(`https://${HOST.coreApi}/api/v3/trem/intensity${suffix}`, HTTP_TIMEOUT.INTENSITY, NO_STORE));
  }
  if (shouldFetchLPGM) {
    reqs.push(withController(`https://${TREM_ARCHIVE_HOST}/api/v2/trem/lpgm${suffix}`, HTTP_TIMEOUT.LPGM, NO_STORE));
  }

  reqs.forEach((request) => activePollingControllers.add(request.controller));

  try {
    const responses = await Promise.all(reqs.map((r) => r.execute().catch(() => null)));

    const out: PolledData = { rts: null, eew: null, intensity: null, lpgm: null };
    const rts = (await parseJson(responses[0])) as RtsV1 | null;
    out.rts = rts ? readRtsV1(rts, lookups) : null;
    out.eew = (await parseJson(responses[1])) as unknown[] | null;
    if (shouldFetchIntensity) {
      out.intensity = readIntensityV1(await parseJson(responses[2]));
    }
    if (shouldFetchLPGM) {
      out.lpgm = (await parseJson(responses[responses.length - 1])) as unknown[] | null;
    }
    return out;
  } finally {
    reqs.forEach((request) => activePollingControllers.delete(request.controller));
  }
}
