/**
 * SSE + multi-endpoint HTTP client — ported from legacy/src/js/index/data/http.js.
 * Uses tauri-plugin-http `fetch` (streaming ReadableStream) so SSE bypasses CORS.
 */
import { appFetch, inTauri } from "@/lib/env";

import { HTTP_TIMEOUT } from "@/lib/constants";
import { getHost, reportFailure, reportSuccess } from "@/lib/endpoints";
import { withController } from "@/lib/http";
import { createLogger } from "@/lib/logger";
import { mark } from "@/lib/perf";
import { variable } from "@/lib/variable";

let sseController: AbortController | null = null;
let requestCounter = 0;
let transportGeneration = 0;
const activePollingControllers = new Set<AbortController>();

const log = createLogger("sse");
const TREM_REPLAY_HOST = "api-1.exptech.dev";

export function abortAll(): void {
  transportGeneration++;
  if (sseController) {
    sseController.abort();
    sseController = null;
  }
  activePollingControllers.forEach((controller) => controller.abort());
  activePollingControllers.clear();
}

export interface SseHandlers {
  onRts?: (v: unknown) => void;
  onEew?: (v: unknown) => void;
  onIntensity?: (v: unknown) => void;
  onLpgm?: (v: unknown) => void;
  reconnectDelay?: number;
}

export interface SseManager {
  abort: () => void;
}

/** Parse an SSE chunk buffer, invoking `emit` for each complete `data:` JSON. */
function makeSseReader(onEvent: (parsed: unknown) => void) {
  let buffer = "";
  const decoder = new TextDecoder();
  return (chunk: Uint8Array) => {
    buffer += decoder.decode(chunk, { stream: true });
    const blocks = buffer.split(/\n\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^data:\s*(.+)$/m);
      if (!m) continue;
      try {
        const parsed = JSON.parse(m[1]);
        if (parsed != null) onEvent(parsed);
      } catch {
        /* skip invalid JSON */
      }
    }
  };
}

/** Open live SSE streams for rts + eew and dispatch parsed events. */
export function init(options: SseHandlers = {}): SseManager {
  const { onRts, onEew, onIntensity, onLpgm, reconnectDelay = 3000 } = options;

  if (sseController) sseController.abort();
  const controller = new AbortController();
  sseController = controller;
  const { signal } = controller;

  // Single pending reconnect timer (shared across both streams AND across rounds)
  // so a burst of instant failures schedules ONE delayed reconnect rather than
  // tight-looping — important when a proxy refuses the connection immediately.
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleReconnect() {
    if (signal.aborted || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      doConnect();
    }, reconnectDelay);
  }

  function doConnect() {
    if (signal.aborted) return;

    // The RTS archive exists on api-1 (the regional core nodes return 404 for
    // this route); EEW history remains on the core pool.
    const rtsDomain = variable.play_mode == 2 ? TREM_REPLAY_HOST : getHost("lbApi");
    const eewDomain = variable.play_mode == 2 ? getHost("coreApi") : getHost("lbApi");

    const urls = [
      { url: `https://${rtsDomain}/api/v2/trem/rts`, type: "rts" as const, enabled: variable.play_mode != 1 },
      { url: `https://${eewDomain}/api/v2/eq/eew`, type: "eew" as const, enabled: variable.play_mode != 1 },
    ].filter((u) => u.enabled);

    for (const u of urls) {
      let eventCount = 0;
      const dispatch = (v: unknown) => {
        if (eventCount++ % 40 === 0) {
          const summary =
            u.type === "rts" && v && typeof v === "object" && "station" in v
              ? `${Object.keys((v as { station?: object }).station ?? {}).length} stations`
              : "event";
          log.debug(`${u.type} data #${eventCount} (${summary})`);
        }
        switch (u.type) {
          case "rts":
            onRts?.(v);
            break;
          case "eew":
            onEew?.(v);
            break;
        }
      };
      const feed = makeSseReader(dispatch);

      appFetch(u.url, {
        signal,
        headers: inTauri
          ? { Accept: "text/event-stream", "Cache-Control": "no-cache" }
          : { Accept: "text/event-stream" },
        ...(!inTauri ? { cache: "no-cache" as const } : {}),
      })
        .then(async (res) => {
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          log.info(`${u.type} connected (${res.status}), streaming…`);
          mark(`sse-${u.type}-connected`);
          reportSuccess("lbApi");
          const reader = res.body.getReader();
          while (!signal.aborted) {
            const { value, done } = await reader.read();
            if (done) {
              log.warn(`${u.type} stream ended → reconnect`);
              scheduleReconnect();
              return;
            }
            if (value) feed(value);
          }
        })
        .catch((e) => {
          // Entering replay intentionally aborts both live streams. That is a
          // mode transition, not a network failure, and must not poison the LB
          // health score or produce a reconnect warning.
          if (signal.aborted || (e as { name?: string })?.name === "AbortError") return;
          log.warn(`${u.type} error → reconnect`, e);
          reportFailure("lbApi");
          scheduleReconnect();
        });
    }
  }

  doConnect();

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
  rts: unknown | null;
  eew: unknown[] | null;
  intensity: unknown[] | null;
  lpgm: unknown[] | null;
}

async function parseJson(response: Response | null): Promise<unknown | null> {
  if (!response?.ok) return null;
  try {
    return await response.json();
  } catch {
    // An intentional mode-transition abort may arrive after response headers
    // but while the body is still being consumed. Treat it as no data.
    return null;
  }
}

/** HTTP polling fallback — RTS/EEW always, intensity every 5th, lpgm every 7th. */
export async function getData(time?: number): Promise<PolledData> {
  const requestGeneration = transportGeneration;
  const requestMode = variable.play_mode;
  const t = time ? Math.round(time / 1000) : 0;
  requestCounter++;
  const shouldFetchLPGM = requestCounter % 7 === 0;
  const shouldFetchIntensity = requestCounter % 5 === 0;

  const lb = getHost("lbApi");
  const tremDomain = requestMode == 2 ? TREM_REPLAY_HOST : lb;
  const eewDomain = requestMode == 2 ? getHost("coreApi") : lb;

  const suffix = t ? `/${t}` : "";
  const reqs: (ReturnType<typeof withController> | null)[] = [
    requestMode == 1 ? null : withController(`https://${tremDomain}/api/v2/trem/rts${suffix}`, HTTP_TIMEOUT.RTS),
    requestMode == 1 ? null : withController(`https://${eewDomain}/api/v2/eq/eew${suffix}`, HTTP_TIMEOUT.EEW),
  ];

  if (shouldFetchIntensity) {
    reqs.push(withController(`https://${tremDomain}/api/v2/trem/intensity${suffix}`, HTTP_TIMEOUT.INTENSITY));
  }
  if (shouldFetchLPGM) {
    reqs.push(withController(`https://${tremDomain}/api/v2/trem/lpgm${suffix}`, HTTP_TIMEOUT.LPGM));
  }

  const activeRequests = reqs.filter((request): request is ReturnType<typeof withController> => !!request);
  activeRequests.forEach((request) => activePollingControllers.add(request.controller));

  try {
    const responses = await Promise.all(
      reqs.map((r) => (r ? r.execute().catch(() => null) : Promise.resolve(null))),
    );

    const out: PolledData = { rts: null, eew: null, intensity: null, lpgm: null };
    out.rts = await parseJson(responses[0]);
    out.eew = (await parseJson(responses[1])) as unknown[] | null;
    if (shouldFetchIntensity) {
      out.intensity = (await parseJson(responses[2])) as unknown[] | null;
    }
    if (shouldFetchLPGM) {
      out.lpgm = (await parseJson(responses[responses.length - 1])) as unknown[] | null;
    }
    // Archive availability must not mark a live LB node healthy/unhealthy.
    if (requestMode == 0 && requestGeneration === transportGeneration) {
      if (out.rts || out.eew) reportSuccess("lbApi");
      else reportFailure("lbApi");
    }
    return out;
  } finally {
    activeRequests.forEach((request) => activePollingControllers.delete(request.controller));
  }
}
