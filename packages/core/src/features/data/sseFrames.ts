/**
 * The live stream's wire format, apart from the connection that carries it, so
 * it can be tested alone: SSE blocks split out of a byte stream, each data
 * field's base64(gzip(…)) undone, and the block handed to the handler its
 * `event:` name asks for.
 *
 * One connection (`/api/v1/sse`) carries every topic; the event name is the
 * topic:
 *
 *   trem.rts.v1        JSON, the station frame (rtsV1.ts)
 *   trem.intensity.v1  TREM XML (intensityV1.ts)
 *   eq.eew.v1          JSON array, every EEW in force — a full snapshot that
 *                      replaces the last one
 *   eq.report.v1       JSON `{ reason, data }`, one earthquake report
 *
 * and the server's own: `info` (the greeting, plain JSON), `unsubscribed`
 * (one topic stopped, plain JSON), `close` (it is closing, plain text), and
 * `: ping <unix s>` comment lines.
 */
import { gunzipSync, strFromU8 } from "fflate";

import type { RtsV1 } from "./rtsV1";

export const TOPIC = {
  rts: "trem.rts.v1",
  intensity: "trem.intensity.v1",
  eew: "eq.eew.v1",
  report: "eq.report.v1",
} as const;

/** What the app subscribes to, in one connection. */
export const LIVE_TOPICS = [TOPIC.intensity, TOPIC.eew, TOPIC.report, TOPIC.rts] as const;

export interface SseFrame {
  event?: string;
  data: string;
  /** A `:` comment line — the server's `: ping <unix s>` heartbeat. */
  comment?: string;
}

/** One SSE block. `:` comments (the server's `: ping`) carry no data. */
export function parseFrame(block: string): SseFrame {
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
export function frameReader() {
  let buffer = "";
  const decoder = new TextDecoder();
  return (chunk: Uint8Array): SseFrame[] => {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, "");
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    return blocks.map(parseFrame);
  };
}

/**
 * A data field of the stream: base64 of gzip of the payload. A field that is
 * not — plain JSON, as the server's own events are — comes back as is.
 */
export function decodePayload(data: string): string {
  const compact = data.replace(/\s+/g, "");
  let bytes: Uint8Array;
  try {
    const binary = atob(compact);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return data;
  }
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return data;
  return strFromU8(gunzipSync(bytes));
}

/** The `info` greeting: the node, the topics granted, and why any were not. */
export interface Greeting {
  location?: string;
  /** Granted, in delivery priority order. */
  topics?: string[];
  denied?: Record<string, string>;
  anonymous?: boolean;
}

/** An eq.report.v1 message. `data` is one report, unchecked. */
export interface ReportMessage {
  reason: number;
  data: unknown;
}

export interface FrameHandlers {
  /** `: ping <unix s>`, the text after the colon. */
  ping?: (text: string) => void;
  /** The greeting, parsed (null when it is not JSON), and verbatim. */
  info?: (greeting: Greeting | null, raw: string) => void;
  rts?: (payload: RtsV1) => void;
  intensity?: (xml: string) => void;
  /** The EEWs in force: replaces the previous list. */
  eew?: (list: unknown) => void;
  report?: (message: ReportMessage) => void;
  /** One topic stopped; the others carry on. */
  unsubscribed?: (topic: string | null, reason: string) => void;
  /** The server is closing the connection. */
  close?: (reason: string) => void;
  /** An event this app does not know. */
  unknown?: (event: string) => void;
  /** A known topic whose payload could not be read. */
  bad?: (event: string, error: unknown) => void;
}

function asJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/**
 * Route one frame to its handler. Returns "close" when the server announced
 * it is closing: the caller ends the connection and reconnects.
 */
export function dispatchFrame(frame: SseFrame, on: FrameHandlers): "close" | undefined {
  if (frame.comment?.startsWith("ping")) on.ping?.(frame.comment);
  if (!frame.data && !frame.event) return undefined;
  const event = frame.event ?? "message";
  switch (event) {
    case "info": {
      let greeting: Greeting | null = null;
      try {
        const parsed = asJson(frame.data);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) greeting = parsed as Greeting;
      } catch {
        /* not JSON: the raw text still goes to the handler */
      }
      on.info?.(greeting, frame.data);
      return undefined;
    }
    case "unsubscribed": {
      let topic: string | null = null;
      let reason = frame.data;
      try {
        const parsed = asJson(frame.data) as { topic?: unknown; reason?: unknown } | null;
        if (parsed && typeof parsed.topic === "string") topic = parsed.topic;
        if (parsed && typeof parsed.reason === "string") reason = parsed.reason;
      } catch {
        /* not JSON: the raw text is the reason */
      }
      on.unsubscribed?.(topic, reason);
      return undefined;
    }
    case "close":
      on.close?.(frame.data);
      return "close";
    case TOPIC.rts:
    case TOPIC.intensity:
    case TOPIC.eew:
    case TOPIC.report:
      break;
    default:
      on.unknown?.(event);
      return undefined;
  }

  let text: string;
  let value: unknown;
  try {
    text = decodePayload(frame.data);
    value = event === TOPIC.intensity ? text : asJson(text);
  } catch (e) {
    on.bad?.(event, e);
    return undefined;
  }

  switch (event) {
    case TOPIC.rts:
      if (value && typeof value === "object" && !Array.isArray(value)) on.rts?.(value as RtsV1);
      else on.bad?.(event, new Error("not a station frame"));
      break;
    case TOPIC.intensity:
      on.intensity?.(value as string);
      break;
    case TOPIC.eew:
      if (Array.isArray(value)) on.eew?.(value);
      else on.bad?.(event, new Error("not a list of EEWs"));
      break;
    case TOPIC.report: {
      const m = value as { reason?: unknown; data?: unknown } | null;
      if (m && typeof m === "object" && typeof m.reason === "number" && m.data && typeof m.data === "object") {
        on.report?.({ reason: m.reason, data: m.data });
      } else {
        on.bad?.(event, new Error("not a report message"));
      }
      break;
    }
  }
  return undefined;
}
