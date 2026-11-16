import { describe, expect, test } from "bun:test";
import { gzipSync, strToU8 } from "fflate";

import {
  decodePayload,
  dispatchFrame,
  frameReader,
  LIVE_TOPICS,
  parseFrame,
  type FrameHandlers,
  type SseFrame,
} from "../src/features/data/sseFrames";

import { block, EEW_SNAPSHOT, GREETING, INTENSITY_XML, packed, reportData, RTS } from "./fixtures";

/** Handlers that record every call, in order. */
function recorder() {
  const calls: [string, ...unknown[]][] = [];
  const on: FrameHandlers = {
    ping: (t) => calls.push(["ping", t]),
    info: (g, raw) => calls.push(["info", g, raw]),
    rts: (p) => calls.push(["rts", p]),
    intensity: (x) => calls.push(["intensity", x]),
    eew: (l) => calls.push(["eew", l]),
    report: (m) => calls.push(["report", m]),
    unsubscribed: (t, r) => calls.push(["unsubscribed", t, r]),
    close: (r) => calls.push(["close", r]),
    unknown: (e) => calls.push(["unknown", e]),
    bad: (e, err) => calls.push(["bad", e, err]),
  };
  return { calls, on };
}

const frame = (event: string | undefined, data: string, comment?: string): SseFrame => ({ event, data, comment });

describe("topics", () => {
  test("one connection asks for intensity, EEW, reports and RTS", () => {
    expect(LIVE_TOPICS.join(",")).toBe("trem.intensity.v1,eq.eew.v1,eq.report.v1,trem.rts.v1");
  });
});

describe("parseFrame / frameReader", () => {
  test("named event, data, and a comment", () => {
    expect(parseFrame("event: eq.eew.v1\ndata: abc")).toEqual({ event: "eq.eew.v1", data: "abc", comment: undefined });
    expect(parseFrame(": ping 1790000000")).toEqual({ event: undefined, data: "", comment: "ping 1790000000" });
    expect(parseFrame("data: a\ndata: b").data).toBe("a\nb");
    // `retry:` and `id:` carry nothing the app reads.
    expect(parseFrame("retry: 3000")).toEqual({ event: undefined, data: "", comment: undefined });
  });

  test("blocks split across chunks, CRLF line ends", () => {
    const split = frameReader();
    const enc = new TextEncoder();
    const wire = "retry: 3000\r\n\r\nevent: info\r\ndata: {}\r\n\r\n: ping 1\r\n\r\nevent: trem.rts.v1\r\ndata: QUJD\r\n\r\n";
    const out: SseFrame[] = [];
    // One byte at a time: every boundary falls inside something.
    for (const byte of enc.encode(wire)) out.push(...split(new Uint8Array([byte])));
    expect(out.map((f) => f.event ?? f.comment ?? "")).toEqual(["", "info", "ping 1", "trem.rts.v1"]);
    expect(out[3].data).toBe("QUJD");
  });

  test("a multi-byte character split between chunks", () => {
    const split = frameReader();
    const bytes = new TextEncoder().encode("event: info\ndata: 臺灣\n\n");
    const cut = bytes.indexOf(0xe8) + 1; // inside 臺
    expect(split(bytes.slice(0, cut))).toEqual([]);
    expect(split(bytes.slice(cut))[0].data).toBe("臺灣");
  });
});

describe("decodePayload", () => {
  test("base64(gzip(…)) is undone", () => {
    expect(decodePayload(packed({ a: 1 }))).toBe('{"a":1}');
    expect(decodePayload(packed("臺灣 <XML/>"))).toBe("臺灣 <XML/>");
  });

  test("line breaks inside the base64 are ignored", () => {
    const b64 = packed({ long: "x".repeat(200) });
    expect(decodePayload(`${b64.slice(0, 10)}\n${b64.slice(10)}`)).toBe(JSON.stringify({ long: "x".repeat(200) }));
  });

  test("plain text, and base64 that is not gzip, come back as is", () => {
    expect(decodePayload('[{"id":"1"}]')).toBe('[{"id":"1"}]');
    expect(decodePayload("QUJD")).toBe("QUJD"); // "ABC"
  });

  test("a truncated gzip member throws", () => {
    const bytes = gzipSync(strToU8(JSON.stringify(RTS)));
    const cut = Buffer.from(bytes.slice(0, bytes.length - 12)).toString("base64");
    expect(() => decodePayload(cut)).toThrow();
  });
});

describe("dispatchFrame", () => {
  test("ping: the heartbeat goes to ping and nothing else", () => {
    const { calls, on } = recorder();
    expect(dispatchFrame(frame(undefined, "", "ping 1790000000"), on)).toBeUndefined();
    expect(calls).toEqual([["ping", "ping 1790000000"]]);
  });

  test("a comment that is not a ping, and an empty block, do nothing", () => {
    const { calls, on } = recorder();
    dispatchFrame(frame(undefined, "", "hello"), on);
    dispatchFrame(frame(undefined, ""), on);
    expect(calls).toEqual([]);
  });

  test("info: the greeting parsed, and verbatim", () => {
    const { calls, on } = recorder();
    const raw = JSON.stringify({ ...GREETING, denied: { "eq.report.v1": "quota exceeded" } });
    dispatchFrame(frame("info", raw), on);
    expect(calls).toEqual([["info", { ...GREETING, denied: { "eq.report.v1": "quota exceeded" } }, raw]]);
  });

  test("info that is not JSON still reaches the handler", () => {
    const { calls, on } = recorder();
    dispatchFrame(frame("info", "hello"), on);
    expect(calls).toEqual([["info", null, "hello"]]);
  });

  test("trem.rts.v1: gzip'd JSON", () => {
    const { calls, on } = recorder();
    dispatchFrame(frame("trem.rts.v1", packed(RTS)), on);
    expect(calls).toEqual([["rts", RTS]]);
  });

  test("trem.intensity.v1: gzip'd XML, as text", () => {
    const { calls, on } = recorder();
    dispatchFrame(frame("trem.intensity.v1", packed(INTENSITY_XML)), on);
    expect(calls).toEqual([["intensity", INTENSITY_XML]]);
  });

  test("eq.eew.v1: the whole snapshot, and an empty one", () => {
    const { calls, on } = recorder();
    dispatchFrame(frame("eq.eew.v1", packed(EEW_SNAPSHOT)), on);
    dispatchFrame(frame("eq.eew.v1", packed([])), on);
    expect(calls).toEqual([
      ["eew", EEW_SNAPSHOT],
      ["eew", []],
    ]);
  });

  test("eq.eew.v1 that is not a list is refused", () => {
    const { calls, on } = recorder();
    dispatchFrame(frame("eq.eew.v1", packed({ id: "x" })), on);
    expect(calls.map((c) => c[0])).toEqual(["bad"]);
    expect(calls[0][1]).toBe("eq.eew.v1");
  });

  test("eq.report.v1: reason and data", () => {
    const { calls, on } = recorder();
    const data = reportData();
    dispatchFrame(frame("eq.report.v1", packed({ reason: 0, data })), on);
    expect(calls).toEqual([["report", { reason: 0, data }]]);
  });

  test("eq.report.v1 without a reason or data is refused", () => {
    const { calls, on } = recorder();
    dispatchFrame(frame("eq.report.v1", packed({ data: reportData() })), on);
    dispatchFrame(frame("eq.report.v1", packed({ reason: 1, data: null })), on);
    expect(calls.map((c) => c[0])).toEqual(["bad", "bad"]);
  });

  test("a payload that is not JSON, or a broken gzip, goes to bad and nothing else", () => {
    const { calls, on } = recorder();
    dispatchFrame(frame("trem.rts.v1", packed("not json")), on);
    const bytes = gzipSync(strToU8("[]"));
    dispatchFrame(frame("eq.eew.v1", Buffer.from(bytes.slice(0, 8)).toString("base64")), on);
    expect(calls.map((c) => [c[0], c[1]])).toEqual([
      ["bad", "trem.rts.v1"],
      ["bad", "eq.eew.v1"],
    ]);
  });

  test("unsubscribed: the topic and the reason", () => {
    const { calls, on } = recorder();
    dispatchFrame(frame("unsubscribed", JSON.stringify({ topic: "trem.rts.v1", reason: "quota exceeded" })), on);
    dispatchFrame(frame("unsubscribed", "gone"), on);
    expect(calls).toEqual([
      ["unsubscribed", "trem.rts.v1", "quota exceeded"],
      ["unsubscribed", null, "gone"],
    ]);
  });

  test("close: the reason, and the caller is told to reconnect", () => {
    const { calls, on } = recorder();
    expect(dispatchFrame(frame("close", "server shutting down"), on)).toBe("close");
    expect(calls).toEqual([["close", "server shutting down"]]);
  });

  test("an event the app does not know", () => {
    const { calls, on } = recorder();
    dispatchFrame(frame("trem.eew.v1", packed({})), on);
    dispatchFrame(frame(undefined, "unnamed"), on);
    expect(calls).toEqual([
      ["unknown", "trem.eew.v1"],
      ["unknown", "message"],
    ]);
  });

  test("a whole connection's bytes, in order", () => {
    const wire =
      "retry: 3000\n\n" +
      block("info", JSON.stringify(GREETING)) +
      block("eq.eew.v1", packed(EEW_SNAPSHOT)) +
      ": ping 1790000000\n\n" +
      block("trem.intensity.v1", packed(INTENSITY_XML)) +
      block("eq.report.v1", packed({ reason: 1, data: reportData() })) +
      block("trem.rts.v1", packed(RTS)) +
      block("close", "bye");
    const { calls, on } = recorder();
    const split = frameReader();
    const bytes = new TextEncoder().encode(wire);
    const results: (string | undefined)[] = [];
    for (let i = 0; i < bytes.length; i += 37) {
      for (const f of split(bytes.slice(i, i + 37))) results.push(dispatchFrame(f, on));
    }
    expect(calls.map((c) => c[0])).toEqual(["info", "eew", "ping", "intensity", "report", "rts", "close"]);
    expect(results.at(-1)).toBe("close");
  });
});
