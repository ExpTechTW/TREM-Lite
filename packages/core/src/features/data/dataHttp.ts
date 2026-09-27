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
 *   rts  api/v1/trem/sse/rts?mode=live — the rts.v1 feed, about 2 Hz, each
 *        frame base64(gzip(JSON)) (see rtsV1.ts). It needs the user's ExpTech
 *        API token: without one it is not opened, and a token the server
 *        refuses stops it until the token changes (see ui.rtsAccess).
 *   eew  api/v2/eq/eew — public, plain JSON.
 */

import { search_loc_name } from "@/domain/utils";
import { boxOf } from "@/features/box/polygons";
import { HTTP_TIMEOUT } from "@/lib/constants";
import { HOST, lbApiHost } from "@/lib/endpoints";
import { events } from "@/lib/events";
import { http, withController, type HttpResponse } from "@/lib/http";
import { createLogger } from "@/lib/logger";
import { mark } from "@/lib/perf";
import type { RtsData } from "@/lib/types";
import { variable } from "@/lib/variable";
import { ui } from "@/lib/variable.ui";

import { readIntensityV1 } from "./intensityV1";
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
 * Reconnect delays double from `reconnectDelay` up to this. Kept short: the
 * eew stream is the early-warning path, and a node that comes back must not
 * sit unused for a minute.
 */
const BACKOFF_MAX_MS = 15_000;

const lookups: RtsV1Lookups = {
  station: (id) => {
    const at = variable.station?.[id]?.info.at(-1);
    return at ? { lon: at.lon, lat: at.lat, code: at.code } : null;
  },
  boxOf,
  townOf: search_loc_name,
};

function setRtsAccess(state: typeof ui.rtsAccess.state, reason = ""): void {
  if (ui.rtsAccess.state === state && ui.rtsAccess.reason === reason) return;
  ui.rtsAccess = { state, reason };
  events.emit("RtsAccessChange");
}

export function abortAll(): void {
  if (sseController) {
    sseController.abort();
    sseController = null;
  }
  activePollingControllers.forEach((controller) => controller.abort());
  activePollingControllers.clear();
}

export interface SseHandlers {
  /** The ExpTech API token for the rts stream; empty leaves it closed. */
  token?: string;
  onRts?: (v: RtsData) => void;
  onEew?: (v: unknown) => void;
  onIntensity?: (v: unknown) => void;
  onLpgm?: (v: unknown) => void;
  reconnectDelay?: number;
}

export interface SseManager {
  abort: () => void;
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
  name: "rts" | "eew";
  url: string;
  token?: string;
  onData: (data: string) => void;
  /** The server refused the token: stop, and do not reconnect with it. */
  onRefused?: (reason: string) => void;
}

/** Keep one stream open until `signal` aborts, reconnecting with backoff. */
function openStream(s: Stream, signal: AbortSignal, reconnectDelay: number): void {
  let failures = 0;
  let frames = 0;

  const connect = () => {
    if (signal.aborted) return;
    // The attempt's own controller, so the stale watchdog can end it alone.
    const attempt = new AbortController();
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
    const retry = () => {
      if (signal.aborted) return;
      setTimeout(connect, Math.min(reconnectDelay * 2 ** failures, BACKOFF_MAX_MS));
      failures++;
    };

    http
      .stream(s.url, {
        signal: attempt.signal,
        token: s.token,
        headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
      })
      .then(async (res) => {
        if (s.onRefused && (res.status === 401 || res.status === 403)) {
          const reason = (await res.text().catch(() => "")).trim() || `HTTP ${res.status}`;
          log.error(`${s.name} refused: ${reason}`);
          s.onRefused(reason);
          return;
        }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        log.info(`${s.name} connected (${res.status}), streaming…`);
        mark(`sse-${s.name}-connected`);
        failures = 0;
        alive();
        const reader = res.body.getReader();
        const split = frameReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            log.warn(`${s.name} stream ended → reconnect`);
            break;
          }
          alive();
          for (const frame of split(value)) {
            // Sent when the token is revoked, just before the server hangs up.
            if (frame.event === "close" && s.onRefused) {
              log.error(`${s.name} closed by the server: ${frame.data || "token revoked"}`);
              s.onRefused(frame.data || "token revoked");
              attempt.abort();
              return;
            }
            if (!frame.data || frame.event === "info") continue;
            if (frames++ % 40 === 0) log.debug(`${s.name} data #${frames}`);
            s.onData(frame.data);
          }
        }
        retry();
      })
      .catch((e) => {
        // Entering replay aborts both streams on purpose. That is a mode
        // transition, not a failure: no warning, no reconnect. (Node health is
        // the HTTP layer's; it ignores aborts too.)
        if (signal.aborted) return;
        if (!attempt.signal.aborted) log.warn(`${s.name} error → reconnect`, e);
        retry();
      })
      .finally(() => {
        clearTimeout(stale);
        signal.removeEventListener("abort", end);
      });
  };

  connect();
}

/** Open the live streams and dispatch parsed events. */
export function init(options: SseHandlers = {}): SseManager {
  const { token = "", onRts, onEew, onIntensity, onLpgm, reconnectDelay = 3000 } = options;

  if (sseController) sseController.abort();
  const controller = new AbortController();
  sseController = controller;
  const { signal } = controller;

  if (token) {
    setRtsAccess("ok");
    openStream(
      {
        name: "rts",
        url: `https://${lbApiHost()}/api/v1/trem/sse/rts?mode=live`,
        token,
        onData: (data) => {
          let payload: RtsV1;
          try {
            payload = JSON.parse(decodePayload(data)) as RtsV1;
          } catch {
            return; // not a frame this client understands
          }
          const rts = readRtsV1(payload, lookups);
          if (rts) onRts?.(rts);
        },
        onRefused: (reason) => setRtsAccess("rejected", reason),
      },
      signal,
      reconnectDelay,
    );
  } else {
    setRtsAccess("missing");
  }

  openStream(
    {
      name: "eew",
      url: `https://${lbApiHost()}/api/v2/eq/eew`,
      onData: (data) => {
        try {
          const parsed: unknown = JSON.parse(data);
          if (parsed != null) onEew?.(parsed);
        } catch {
          /* skip invalid JSON */
        }
      },
    },
    signal,
    reconnectDelay,
  );

  // Unused onIntensity/onLpgm are kept for parity with the polling path.
  void onIntensity;
  void onLpgm;

  return {
    abort: () => {
      controller.abort();
      if (sseController === controller) sseController = null;
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
 * HTTP polling — replay's transport. RTS and intensity come from the v3
 * archives (rts.v1, intensity.v1), and RTS only in replay: live station data
 * is the stream's alone. EEW always, intensity every 5th call, lpgm every 7th.
 */
export async function getData(time?: number): Promise<PolledData> {
  const requestMode = variable.play_mode;
  const t = time ? Math.round(time / 1000) : 0;
  requestCounter++;
  const shouldFetchLPGM = requestCounter % 7 === 0;
  const shouldFetchIntensity = requestCounter % 5 === 0;

  const lb = lbApiHost();
  const archiveDomain = requestMode == 2 ? TREM_ARCHIVE_HOST : lb;
  const eewDomain = requestMode == 2 ? HOST.coreApi : lb;

  const suffix = t ? `/${t}` : "";
  const reqs: (ReturnType<typeof withController> | null)[] = [
    requestMode == 2 ? withController(`https://${HOST.coreApi}/api/v3/trem/rts${suffix}`, HTTP_TIMEOUT.RTS, NO_STORE) : null,
    requestMode == 1 ? null : withController(`https://${eewDomain}/api/v2/eq/eew${suffix}`, HTTP_TIMEOUT.EEW, NO_STORE),
  ];

  if (shouldFetchIntensity) {
    reqs.push(withController(`https://${HOST.coreApi}/api/v3/trem/intensity${suffix}`, HTTP_TIMEOUT.INTENSITY, NO_STORE));
  }
  if (shouldFetchLPGM) {
    reqs.push(withController(`https://${archiveDomain}/api/v2/trem/lpgm${suffix}`, HTTP_TIMEOUT.LPGM, NO_STORE));
  }

  const activeRequests = reqs.filter((request): request is ReturnType<typeof withController> => !!request);
  activeRequests.forEach((request) => activePollingControllers.add(request.controller));

  try {
    const responses = await Promise.all(
      reqs.map((r) => (r ? r.execute().catch(() => null) : Promise.resolve(null))),
    );

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
    activeRequests.forEach((request) => activePollingControllers.delete(request.controller));
  }
}
