/**
 * The live connection end to end against a local SSE server: the URL it asks
 * for, each topic reaching its handler, the status lights, `close` and
 * reconnect, and the sleep/live handover.
 *
 * `@/lib/http` is replaced so the stream goes to 127.0.0.1 whatever host the
 * app writes: nothing here reaches an ExpTech server. The app modules the
 * stream code leans on (logger, clock, map lookups) are stubbed.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

import { block, EEW_SNAPSHOT, GREETING, INTENSITY_XML, packed, reportData, RTS } from "./fixtures";

interface Conn {
  url: URL;
  push: (text: string) => void;
  closed: boolean;
}

const conns: Conn[] = [];
/** The URLs the app asked for, before they were pointed at the local server. */
const asked: string[] = [];
const logs: string[] = [];
const enc = new TextEncoder();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const conn: Conn = {
      url: new URL(req.url),
      push: (text) => {
        try {
          ctl.enqueue(enc.encode(text));
        } catch {
          /* closed */
        }
      },
      closed: false,
    };
    const body = new ReadableStream<Uint8Array>({
      start: (c) => void (ctl = c),
      cancel: () => void (conn.closed = true),
    });
    req.signal.addEventListener("abort", () => (conn.closed = true));
    conns.push(conn);
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  },
});

mock.module("@/lib/http", () => ({
  http: {
    stream: (url: string, options: { signal?: AbortSignal; headers?: Record<string, string> }) => {
      asked.push(url);
      const u = new URL(url);
      return fetch(`http://127.0.0.1:${server.port}${u.pathname}${u.search}`, {
        signal: options.signal,
        headers: options.headers,
      });
    },
  },
  withController: () => {
    throw new Error("no polling in this test");
  },
}));
mock.module("@/lib/logger", () => ({
  createLogger: () => {
    const put = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    return { debug: put, info: put, warn: put, error: put };
  },
  fmtDur: (ms: number) => `${Math.round(ms)}ms`,
  fmtBytes: (n: number) => `${n}B`,
}));
mock.module("@/lib/ntp", () => ({ realNow: () => Date.now(), now: () => Date.now(), adoptServerTime: () => {} }));
mock.module("@/lib/perf", () => ({ mark: () => {} }));
mock.module("@/domain/utils", () => ({ search_loc_name: () => null, intensity_float_to_int: (i: number) => Math.round(i) }));
mock.module("@/features/box/polygons", () => ({ boxOf: () => null }));
mock.module("@/lib/variable", () => ({ variable: { station: {} } }));

const { init, streamStatus } = await import("../src/features/data/dataHttp");

async function waitFor(what: string, ok: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const URL_LIVE =
  "https://api.lb.exptech.dev/api/v1/sse?topics=trem.intensity.v1,eq.eew.v1,eq.report.v1,trem.rts.v1&mode=live";
const URL_ASLEEP = "https://api.lb.exptech.dev/api/v1/sse?topics=trem.intensity.v1,eq.eew.v1,eq.report.v1,trem.rts.v1";

describe("the live connection", () => {
  const got = {
    rts: [] as unknown[],
    eew: [] as unknown[],
    intensity: [] as unknown[],
    report: [] as unknown[],
    connects: 0,
  };
  let manager: ReturnType<typeof init>;

  beforeAll(() => {
    manager = init({
      reconnectDelay: 20,
      onRts: (v) => got.rts.push(v),
      onEew: (v) => got.eew.push(v),
      onIntensity: (v) => got.intensity.push(v),
      onReport: (v) => got.report.push(v),
      onConnect: () => got.connects++,
    });
  });

  afterAll(() => {
    manager.abort();
    server.stop(true);
  });

  test("one connection, every topic, mode=live while awake", async () => {
    await waitFor("the first connection", () => conns.length === 1);
    expect(asked).toEqual([URL_LIVE]);
    expect(conns[0].url.pathname).toBe("/api/v1/sse");
    expect(streamStatus("eew").ok).toBe(false);

    conns[0].push(`retry: 3000\n\n${block("info", JSON.stringify(GREETING))}`);
    await waitFor("the greeting", () => got.connects === 1);
    expect(streamStatus("eew")).toEqual({ ok: true, why: "" });
    expect(streamStatus("rts")).toEqual({ ok: true, why: "" });
  });

  test("each topic reaches its handler, decoded", async () => {
    const report = { reason: 0, data: reportData() };
    conns[0].push(
      block("eq.eew.v1", packed(EEW_SNAPSHOT)) +
        block("eq.report.v1", packed(report)) +
        ": ping 1790000000\n\n" +
        block("trem.rts.v1", packed(RTS)) +
        block("trem.intensity.v1", packed(INTENSITY_XML)),
    );
    await waitFor("every topic", () => got.intensity.length === 1);
    expect(got.eew).toEqual([EEW_SNAPSHOT]);
    expect(got.report).toEqual([report]);
    expect(got.rts).toHaveLength(1);
    expect((got.rts[0] as { station: Record<string, unknown> }).station["117825C"]).toEqual({ i: 2.1, pga: 3.5, alert: true });
    expect(got.intensity[0]).toEqual([
      { id: Date.UTC(2026, 8, 17, 4, 0, 0), serial: 1, status: "issued", max: 2, area: { 2: [970], 1: [972, 973] } },
    ]);
  });

  test("a topic the server stops turns its light red, in words that do not name it", async () => {
    conns[0].push(block("unsubscribed", JSON.stringify({ topic: "trem.rts.v1", reason: "quota exceeded" })));
    await waitFor("the rts light", () => !streamStatus("rts").ok);
    expect(streamStatus("rts").why).toContain("quota exceeded");
    expect(streamStatus("rts").why).not.toMatch(/trem\.|eq\./);
    expect(streamStatus("eew").ok).toBe(true);
  });

  test("close: reconnect at once, and a new connection asks for every topic again", async () => {
    conns[0].push(block("close", "server restarting"));
    await waitFor("the reconnect", () => conns.length === 2);
    await waitFor("the first connection closed", () => conns[0].closed);
    expect(asked[1]).toBe(URL_LIVE);

    conns[1].push(
      block(
        "info",
        JSON.stringify({ location: "lb-test", topics: ["trem.intensity.v1", "eq.report.v1", "trem.rts.v1"], denied: { "eq.eew.v1": "quota exceeded" } }),
      ),
    );
    await waitFor("the second greeting", () => got.connects === 2);
    expect(streamStatus("rts").ok).toBe(true);
    const eew = streamStatus("eew");
    expect(eew.ok).toBe(false);
    expect(eew.why).not.toMatch(/eq\.eew|api\//);
    expect(logs.some((l) => l.includes("伺服器主動關閉"))).toBe(true);
  });

  test("going to sleep hands over to a connection without mode=live", async () => {
    manager.setBackground(true);
    await waitFor("the handover connection", () => conns.length === 3);
    expect(asked[2]).toBe(URL_ASLEEP);
    // The old one stays until the new one is up.
    expect(conns[1].closed).toBe(false);
    conns[2].push(block("info", JSON.stringify(GREETING)));
    await waitFor("the old connection closed", () => conns[1].closed);
    expect(got.connects).toBe(3);
    expect(streamStatus("eew").ok).toBe(true);
  });

  test("stopping closes it and nothing reconnects", async () => {
    manager.abort();
    await waitFor("the connection closed", () => conns[2].closed);
    await new Promise((r) => setTimeout(r, 100));
    expect(conns).toHaveLength(3);
    expect(streamStatus("eew").ok).toBe(false);
  });
});
