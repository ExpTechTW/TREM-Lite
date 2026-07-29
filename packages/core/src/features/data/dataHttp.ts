/**
 * SSE + multi-endpoint HTTP client — ported from legacy/src/js/index/data/http.js.
 * Uses tauri-plugin-http `fetch` (streaming ReadableStream) so SSE bypasses CORS.
 */
import { appFetch } from "@/lib/env";

import { HTTP_TIMEOUT } from "@/lib/constants";
import { getHost, reportFailure, reportSuccess } from "@/lib/endpoints";
import { withController } from "@/lib/http";
import { createLogger } from "@/lib/logger";
import { mark } from "@/lib/perf";
import { variable } from "@/lib/variable";

let sseController: AbortController | null = null;
let requestCounter = 0;

const log = createLogger("sse");

export function abortAll(): void {
  if (sseController) {
    sseController.abort();
    sseController = null;
  }
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
  sseController = new AbortController();
  const { signal } = sseController;

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

    // Replay pulls historical data from a core node; live streams from the lb node.
    const rtsDomain = variable.play_mode == 2 ? getHost("coreApi") : getHost("lbApi");
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
        headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
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
          log.warn(`${u.type} error → reconnect`, e);
          reportFailure("lbApi");
          if (!signal.aborted) scheduleReconnect();
        });
    }
  }

  doConnect();

  // Unused onIntensity/onLpgm are kept for parity with the polling path.
  void onIntensity;
  void onLpgm;

  return {
    abort: () => sseController?.abort(),
  };
}

export interface PolledData {
  rts: unknown | null;
  eew: unknown[] | null;
  intensity: unknown[] | null;
  lpgm: unknown[] | null;
}

/** HTTP polling fallback — RTS/EEW always, intensity every 5th, lpgm every 7th. */
export async function getData(time?: number): Promise<PolledData> {
  const t = time ? Math.round(time / 1000) : 0;
  requestCounter++;
  const shouldFetchLPGM = requestCounter % 7 === 0;
  const shouldFetchIntensity = requestCounter % 5 === 0;

  const lb = getHost("lbApi");
  const rtsDomain = variable.play_mode == 2 ? getHost("coreApi") : lb;
  const eewDomain = variable.play_mode == 2 ? getHost("coreApi") : lb;

  const suffix = t ? `/${t}` : "";
  const reqs: (ReturnType<typeof withController> | null)[] = [
    variable.play_mode == 1 ? null : withController(`https://${rtsDomain}/api/v2/trem/rts${suffix}`, HTTP_TIMEOUT.RTS),
    variable.play_mode == 1 ? null : withController(`https://${eewDomain}/api/v2/eq/eew${suffix}`, HTTP_TIMEOUT.EEW),
  ];

  if (shouldFetchIntensity) {
    reqs.push(withController(`https://${lb}/api/v2/trem/intensity${suffix}`, HTTP_TIMEOUT.INTENSITY));
  }
  if (shouldFetchLPGM) {
    reqs.push(withController(`https://${lb}/api/v2/trem/lpgm${suffix}`, HTTP_TIMEOUT.LPGM));
  }

  const responses = await Promise.all(
    reqs.map((r) => (r ? r.execute().catch(() => null) : Promise.resolve(null))),
  );

  const out: PolledData = { rts: null, eew: null, intensity: null, lpgm: null };
  if (responses[0]?.ok) out.rts = await responses[0].json();
  if (responses[1]?.ok) out.eew = await responses[1].json();
  if (shouldFetchIntensity && responses[2]?.ok) out.intensity = await responses[2].json();
  if (shouldFetchLPGM && responses[responses.length - 1]?.ok) {
    out.lpgm = await responses[responses.length - 1]!.json();
  }
  if (variable.play_mode != 1) {
    if (out.rts || out.eew) reportSuccess("lbApi");
    else reportFailure("lbApi");
  }
  return out;
}
