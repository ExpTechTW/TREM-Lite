/**
 * Central event bus — replaces the Node `EventEmitter` at
 * `TREM.variable.events` in the Electron app. Same event names, typed payloads.
 *
 * mitt, with one change: a handler that throws is logged and the rest still
 * run. mitt's own `emit` stops at the first exception and hands it to whoever
 * emitted — for an RTS frame, the SSE reader, which took it for a broken
 * connection. When the map's WebGL context was lost (9-30), every RTS frame
 * threw in the map code: the station stream reconnected over a thousand
 * times, and the modules after the map's in line — sound, speech, the alert
 * window — never heard those frames. One module failing now costs only that
 * module's work.
 */
import mitt, { type Emitter, type Handler, type WildcardHandler } from "mitt";

import { createLogger } from "./logger";
import type { TremEvents } from "./types";

const log = createLogger("event");

/** The same failure, logged once a minute with how often it recurred. */
const REPEAT_MS = 60_000;
const failures = new Map<string, { at: number; again: number }>();

function failed(type: keyof TremEvents | "*", e: unknown): void {
  const key = `${String(type)}|${e instanceof Error ? e.message : String(e)}`;
  const now = performance.now();
  const seen = failures.get(key);
  if (seen && now - seen.at < REPEAT_MS) {
    seen.again++;
    return;
  }
  const again = seen?.again ? `（前 ${REPEAT_MS / 1000}s 又發生 ${seen.again} 次）` : "";
  failures.set(key, { at: now, again: 0 });
  log.error(`處理事件 ${String(type)} 時出錯，其他模組照常${again}：`, e);
}

const bus: Emitter<TremEvents> = mitt<TremEvents>();

bus.emit = ((type: keyof TremEvents, event?: unknown) => {
  const handlers = bus.all.get(type) as Handler<unknown>[] | undefined;
  for (const handler of handlers?.slice() ?? []) {
    try {
      handler(event);
    } catch (e) {
      failed(type, e);
    }
  }
  const wildcards = bus.all.get("*") as WildcardHandler<TremEvents>[] | undefined;
  for (const handler of wildcards?.slice() ?? []) {
    try {
      handler(type, event as TremEvents[keyof TremEvents]);
    } catch (e) {
      failed("*", e);
    }
  }
}) as Emitter<TremEvents>["emit"];

export const events: Emitter<TremEvents> = bus;

export type { TremEvents };
