/**
 * The app's standard time. Every wall-clock reading in the app — what the
 * clock shows, a report's or an EEW's age, when data last came — goes through
 * here, never through the local clock alone.
 *
 *   realNow()  the calibrated time: the local clock plus the offset `syncClock`
 *              measured against ExpTech's time server
 *   now()      the same, or the replay's clock while a replay runs — the time
 *              the data being shown belongs to
 *
 * Calibration (every CALIBRATE_MS, and at start): the desktop asks Rust
 * (src-tauri/src/ntp.rs — SNTP to time.exptech.com.tw, or HTTP when UDP is
 * blocked); the web asks lb.exptech.dev/ntp over HTTP itself. Both take the NTP
 * offset ((t2 − t1) + (t3 − t4)) / 2. The web cannot read the server's
 * x-ntp-t2/t3 headers across origins, so it uses the body, which is t3, for
 * both t2 and t3 — the server's own time between them is well under a
 * millisecond.
 *
 * Elapsed time (a timeout, a rate) is not wall-clock time: it is measured with
 * performance.now(), which a calibration never moves.
 */
import { invoke } from "@tauri-apps/api/core";

import { inTauri } from "./env";
import { http } from "./http";
import { createLogger } from "./logger";
import { variable } from "./variable";

const log = createLogger("clock");
const CALIBRATE_MS = 600_000;
const HTTP_NTP = "https://lb.exptech.dev/ntp";
/** A sample whose round trip took longer than this says too little. */
const MAX_RTT_MS = 1_000;

/** Calibrated wall-clock time in ms. */
export function realNow(): number {
  return Date.now() + variable.cache.time.offset;
}

/** Replay-aware standard time in ms: the replay's clock during a replay. */
export function now(): number {
  const v = variable;
  if ((v.play_mode === 2 || v.play_mode === 3) && v.replay.start_time) {
    // Match the legacy clock: anchor elapsed real time on the first replay
    // tick. Without this initialization `Date.now() - 0` adds an entire Unix
    // epoch to the requested archive timestamp.
    if (!v.replay.local_time) v.replay.local_time = realNow();
    return v.replay.start_time + (realNow() - v.replay.local_time);
  }
  return realNow();
}

async function measure(): Promise<{ offset_ms: number; rtt_ms: number; via: string }> {
  if (inTauri) return invoke("ntp_sync");
  const t1 = Date.now();
  const res = await http.request(HTTP_NTP, { store: false, timeout: 3_000 });
  const t4 = Date.now();
  const t3 = Number((await res.text()).trim());
  if (!res.ok || !Number.isFinite(t3)) throw new Error(`ntp: HTTP ${res.status}`);
  return { offset_ms: (t3 - t1 + (t3 - t4)) / 2, rtt_ms: t4 - t1, via: "http" };
}

/** Measure the offset once; a failed or slow measurement keeps the last one. */
export async function syncClock(): Promise<void> {
  try {
    const r = await measure();
    if (r.rtt_ms > MAX_RTT_MS) throw new Error(`round trip ${Math.round(r.rtt_ms)} ms`);
    variable.cache.time.offset = r.offset_ms;
    log.info(`calibrated via ${r.via}: offset ${r.offset_ms.toFixed(1)} ms, rtt ${r.rtt_ms.toFixed(1)} ms`);
  } catch (err) {
    log.warn("calibration failed, keeping the last offset", err);
  }
}

/** Calibrate now and every CALIBRATE_MS. */
export function startClock(): void {
  void syncClock();
  setInterval(() => void syncClock(), CALIBRATE_MS);
}
