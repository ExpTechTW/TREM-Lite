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
import { INTENSITY_LIST } from "@/lib/constants";
import { createLogger, fmtBytes, fmtDur } from "@/lib/logger";
import { adoptServerTime, realNow } from "@/lib/ntp";
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

/** 每條連線每隔多久在日誌寫一次統計。 */
const SUMMARY_EVERY_MS = 300_000;
/** 心跳間隔超過這個才記警告（伺服器固定 60 秒送一次）。 */
const PING_GAP_WARN_MS = 75_000;
/** 心跳時間戳跟本機（已對時）差超過這麼多秒才記警告。 */
const PING_SKEW_WARN_S = 5;

let connSeq = 0;

/**
 * 一條連線從撥出到結束的紀錄，照 trem-monitor（live.rs 的 ConnLog）：撥出、HTTP、
 * 問候、心跳、每 5 分鐘的統計，結束時一行總結——被交接或停止收掉的也有，所以
 * 日誌裡每條連線都有頭有尾。
 */
class ConnLog {
  readonly label: string;
  private readonly started = performance.now();
  private ready: number | null = null;
  private readonly frames = new Map<string, { n: number; bytes: number }>();
  private pings = 0;
  private lastPing: number | null = null;
  private lastSummary = performance.now();
  /** 失敗的原因；沒有＝被我們收掉（交接、切模式、進重播）。 */
  outcome: string | null = null;

  constructor(stream: string, url: string) {
    this.label = `${stream}#${++connSeq}`;
    log.info(`${this.label} 撥出 ${url}`);
  }

  since(): string {
    return fmtDur(performance.now() - this.started);
  }

  http(res: Response): void {
    // A browser only shows these where CORS exposes them: named when present.
    const seen = ["x-served-by", "cf-ray"]
      .map((name) => [name, res.headers.get(name)] as const)
      .filter(([, value]) => value)
      .map(([name, value]) => `，${name}=${value}`)
      .join("");
    log.info(`${this.label} HTTP ${res.status}（撥出後 ${this.since()}${seen}）`);
  }

  /** `event: info` 的內容：節點名稱、拿到的 topic、被拒的 topic 與原因。 */
  greeting(data: string): void {
    log.info(`${this.label} 問候（撥出後 ${this.since()}）：${data}`);
    try {
      const g = JSON.parse(data) as { location?: string; topics?: string[]; denied?: Record<string, string> };
      const wanted = this.label.startsWith("trem") ? TOPICS.split(",") : [];
      if (g.topics) log.info(`${this.label} 連上 ${g.location ?? "?"}：收 ${g.topics.length}/${wanted.length} 個 topic`);
      else log.info(`${this.label} 連上 ${g.location ?? "?"}`);
      for (const [topic, reason] of Object.entries(g.denied ?? {})) {
        log.warn(`${this.label} ${topic} 沒拿到：${reason}。其他 topic 照收，這個等下次重連再要`);
      }
    } catch {
      /* 問候不是 JSON：原文已經記下 */
    }
  }

  up(): void {
    this.ready = performance.now();
  }

  frame(kind: string, bytes: number): void {
    const f = this.frames.get(kind) ?? { n: 0, bytes: 0 };
    f.n++;
    f.bytes += bytes;
    this.frames.set(kind, f);
    this.maybeSummary();
  }

  /** `: ping <unix 秒>`：記間隔，順便比對伺服器時間。 */
  ping(text: string): void {
    const now = performance.now();
    if (this.lastPing !== null && now - this.lastPing > PING_GAP_WARN_MS) {
      log.warn(`${this.label} 心跳間隔 ${fmtDur(now - this.lastPing)}（正常 60s）`);
    }
    const ts = Number(text.replace(/^ping\s*/, ""));
    if (Number.isFinite(ts) && ts > 0) {
      const skew = Math.round(realNow() / 1000 - ts);
      if (Math.abs(skew) > PING_SKEW_WARN_S) {
        log.warn(`${this.label} 心跳時間戳跟本機差 ${skew}s（伺服器 ${ts}）：傳輸延遲或時鐘不準`);
        // Only when calibration has not been working (see ntp.ts).
        adoptServerTime(ts * 1000, ` ${this.label} 心跳`);
      }
    }
    this.pings++;
    this.lastPing = now;
    this.maybeSummary();
  }

  private stats(): string {
    const perTopic = [...this.frames].map(([k, f]) => `${k} ${f.n} 筆／${fmtBytes(f.bytes)}`).join("、") || "沒有資料";
    const last = this.lastPing === null ? "" : `，最後一次 ${fmtDur(performance.now() - this.lastPing)} 前`;
    return `${perTopic}；心跳 ${this.pings} 次${last}`;
  }

  private maybeSummary(): void {
    if (performance.now() - this.lastSummary < SUMMARY_EVERY_MS) return;
    this.lastSummary = performance.now();
    log.info(`${this.label} 統計（已連 ${this.since()}）：${this.stats()}`);
  }

  end(): void {
    const why = this.outcome ?? "被收掉（交接、切換模式、進入重播或停止）";
    const write = this.outcome ? log.warn : log.info;
    if (this.ready !== null) {
      write(
        `${this.label} 結束：${why}。歷時 ${this.since()}（連上 ${fmtDur(performance.now() - this.ready)}），${this.stats()}`,
      );
    } else {
      write(`${this.label} 結束（沒連上）：${why}。歷時 ${this.since()}`);
    }
  }
}

const shindo = (i: number) => INTENSITY_LIST[i] ?? String(i);

/** A stream's state, for the status lights next to the clock (TimeBar). */
interface Health {
  /** The connection in use has had its greeting and has not ended since. */
  up: boolean;
  /** performance.now() of its last byte: a frame or a heartbeat. */
  last: number;
}

const health: Record<string, Health> = {};

/**
 * Whether a stream is working: connected, and heard from within STALE_MS (the
 * server's heartbeat comes each 60 s). `why` says what is wrong when it is not.
 */
export function streamStatus(name: "trem" | "eew"): { ok: boolean; why: string } {
  const h = health[name];
  if (!h?.up) return { ok: false, why: h ? "連線中斷，重連中" : "尚未連線" };
  const quiet = performance.now() - h.last;
  if (quiet > STALE_MS) return { ok: false, why: `${fmtDur(quiet)} 沒有收到任何資料` };
  return { ok: true, why: "" };
}

/** 一個 EEW 訊框的內容，一則一段：編號、第幾報、單位、預警或警報、規模與震央。 */
function eewSummary(parsed: unknown): string {
  const list = (Array.isArray(parsed) ? parsed : [parsed]) as {
    id?: string;
    serial?: number;
    author?: string;
    status?: number;
    eq?: { mag?: number; loc?: string; max?: number };
    time?: number;
  }[];
  if (!list.length) return "空的（目前沒有生效中的預警）";
  return list
    .map((e) => {
      const kind = e.status === 1 ? "警報" : e.status === 3 ? "取消" : "預警";
      const lag = e.time && e.time > 1e12 ? `，發布後 ${fmtDur(realNow() - e.time)} 收到` : "";
      return `${e.author ?? "?"} ${e.id ?? "?"} 第 ${e.serial ?? "?"} 報 ${kind} M${e.eq?.mag ?? "?"} ${e.eq?.loc ?? "?"} 最大 ${shindo(e.eq?.max ?? -1)}${lag}`;
    })
    .join("；");
}

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
  /** A `:` comment line — the server's `: ping <unix s>` heartbeat. */
  comment?: string;
}

/** One SSE block. `:` comments (the server's `: ping`) carry no data. */
function parseFrame(block: string): SseFrame {
  let event: string | undefined;
  let comment: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line) continue;
    if (line.startsWith(":")) {
      comment = line.slice(1).trim();
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return { event, data: data.join("\n"), comment };
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
  onFrame: (frame: SseFrame, conn: ConnLog) => void;
}

/**
 * Keep one stream open until `signal` aborts, reconnecting with backoff.
 * `handover()` opens a second connection and closes the first once the new one
 * is up (READY_MS); should the new one fail first, the old one carries on and
 * the handover is tried again.
 */
function openStream(s: Stream, signal: AbortSignal, reconnectDelay: number): { handover: () => void } {
  let failures = 0;
  /** The connection in use, and one taking over from it. */
  let active: AbortController | null = null;
  let pending: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  /** The connection in use, for the handover's log line. */
  let activeLabel = "";
  const state: Health = (health[s.name] = { up: false, last: 0 });
  signal.addEventListener("abort", () => (state.up = false), { once: true });

  const later = (handover: boolean) => {
    if (signal.aborted) return;
    if (retryTimer) clearTimeout(retryTimer);
    const delay = Math.min(reconnectDelay * 2 ** failures, BACKOFF_MAX_MS);
    log.info(`${s.name} ${fmtDur(delay)} 後${handover ? "再試交接" : "重連"}（連續失敗 ${failures + 1} 次）`);
    retryTimer = setTimeout(() => connect(handover), delay);
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
    const url = s.url();
    const conn = new ConnLog(s.name, url);
    const waited = performance.now();
    let stale: ReturnType<typeof setTimeout> | undefined;
    const alive = () => {
      clearTimeout(stale);
      stale = setTimeout(() => {
        conn.outcome = `${fmtDur(STALE_MS)} 沒有任何資料（心跳 60s 一次），視為斷線`;
        attempt.abort();
      }, STALE_MS);
    };
    let up = false;
    const notReady = setTimeout(() => {
      conn.outcome = `${fmtDur(READY_MS)} 內沒有問候，放棄這條連線`;
      attempt.abort();
    }, READY_MS);

    http
      .stream(url, {
        signal: attempt.signal,
        headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
      })
      .then(async (res) => {
        conn.http(res);
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        mark(`sse-${s.name}-connected`);
        alive();
        const reader = res.body.getReader();
        const split = frameReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) throw new Error("stream ended");
          alive();
          if (attempt === active) state.last = performance.now();
          for (const frame of split(value)) {
            if (frame.comment?.startsWith("ping")) conn.ping(frame.comment);
            if (!frame.data && !frame.event) continue;
            if (!up) {
              up = true;
              conn.up();
              clearTimeout(notReady);
              failures = 0;
              if (pending === attempt) {
                log.info(
                  `交接完成：${conn.label} 就緒（等了 ${fmtDur(performance.now() - waited)}），關閉舊連線 ${activeLabel}`,
                );
                // Also drops a reconnect the replaced connection had asked for.
                if (retryTimer) clearTimeout(retryTimer);
                retryTimer = null;
                active?.abort();
                active = attempt;
                pending = null;
              }
              activeLabel = conn.label;
              state.up = true;
              state.last = performance.now();
            }
            conn.frame(frame.event ?? "message", frame.data.length);
            if (frame.event === "info") conn.greeting(frame.data);
            s.onFrame(frame, conn);
          }
        }
      })
      .catch((e) => {
        // Entering replay aborts both streams on purpose, and a handover
        // closes the connection it replaced. Neither is a failure: no warning,
        // no reconnect. (Node health is the HTTP layer's; it ignores aborts too.)
        if (!attempt.signal.aborted) conn.outcome = e instanceof Error ? e.message : String(e);
        if (signal.aborted) return;
        if (pending === attempt && !up) {
          log.warn(`交接失敗：新連線 ${conn.label} 在就緒前就結束，保留目前的連線 ${activeLabel}`);
          pending = null;
          later(true);
          return;
        }
        if (attempt !== active) return;
        later(false);
      })
      .finally(() => {
        clearTimeout(stale);
        clearTimeout(notReady);
        signal.removeEventListener("abort", end);
        // The connection in use ended (not one a handover replaced).
        if (attempt === active) state.up = false;
        conn.end();
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
  log.info(
    `啟動即時連線：節點 ${lbApiHost()}，trem topic ${TOPICS}（${background ? "休眠：rts 只收有測站觸發的資料" : "live"}），eew 為 CWA 預警`,
  );

  const trem = openStream(
    {
      name: "trem",
      url: () => `https://${lbApiHost()}/api/v1/trem/sse?topics=${TOPICS}${background ? "" : "&mode=live"}`,
      onFrame: (frame, conn) => {
        switch (frame.event) {
          case "info":
            return; // the greeting: logged by the connection
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
            if (report) {
              log.info(
                `${conn.label} 收到 trem.intensity.v1：EventID=${report.id} 第 ${report.serial} 報 ${report.status} 最大震度 ${shindo(report.max)}（${fmtBytes(frame.data.length)}）`,
              );
              onIntensity?.([report]);
            } else {
              log.warn(`${conn.label} trem.intensity.v1 解不開，略過（${fmtBytes(frame.data.length)}）`);
            }
            return;
          }
          case "unsubscribed":
            log.warn(`${conn.label} topic 被伺服器停掉：${frame.data}。其他 topic 照收，等下次重連再要`);
            return;
          case "close":
            log.warn(`${conn.label} 伺服器主動關閉：${frame.data}`);
            return;
          default:
            log.info(`${conn.label} 略過 app 不認得的 event ${frame.event ?? "message"}`);
            return;
        }
      },
    },
    signal,
    reconnectDelay,
  );

  const eew = openStream(
    {
      name: "eew",
      url: () => `https://${lbApiHost()}/api/v2/eq/eew?sse=1`,
      onFrame: (frame, conn) => {
        // The `info` greeting names the node that answered (logged by the
        // connection); EEWs come unnamed.
        if (frame.event) return;
        try {
          const parsed: unknown = JSON.parse(frame.data);
          if (parsed != null) {
            log.info(`${conn.label} 收到 EEW：${eewSummary(parsed)}（${fmtBytes(frame.data.length)}）`);
            onEew?.(parsed);
          }
        } catch {
          log.warn(`${conn.label} EEW 不是合法的 JSON，略過：${frame.data.slice(0, 200)}`);
        }
      },
    },
    signal,
    reconnectDelay,
  );

  // A network that comes back (another Wi-Fi, the machine waking) can leave
  // a connection that looks open and is dead, which STALE_MS takes a minute
  // and a half to notice, or one still waiting out its backoff. Both streams
  // take a fresh connection at once, each keeping the old until it is up.
  if (typeof window !== "undefined") {
    const renew = () => {
      log.info("網路恢復：trem 與 eew 各建立新連線，舊的留到交接完成");
      trem.handover();
      eew.handover();
    };
    window.addEventListener("online", renew);
    signal.addEventListener("abort", () => window.removeEventListener("online", renew), { once: true });
  }

  return {
    abort: () => {
      if (!signal.aborted) log.info("停止即時連線（進入重播或重設）");
      controller.abort();
      if (sseController === controller) sseController = null;
    },
    setBackground: (value) => {
      if (value === background || signal.aborted) return;
      background = value;
      log.info(`切成${background ? "休眠" : " live "}模式，trem 建立新連線，舊的留到交接完成`);
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
