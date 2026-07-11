/**
 * Corrected "now" — ported from legacy/src/js/index/utils/ntp.js.
 * Real NTP sync is done in Rust (ntp_sync command); we keep the offset here.
 */
import { invoke } from "@tauri-apps/api/core";

import { variable } from "./variable";

/** Replay-aware, NTP-corrected current time in ms. */
export function now(): number {
  const v = variable;

  // Replay modes drive time from the replay clock.
  if (v.play_mode === 2 || v.play_mode === 3) {
    if (v.replay.start_time) {
      return v.replay.start_time + (Date.now() - v.replay.local_time);
    }
  }

  return Date.now() + (v.cache.time.offset || 0);
}

/** Ask Rust for the NTP offset and cache it. Safe to call periodically. */
export async function syncNtp(): Promise<void> {
  try {
    const res = await invoke<{ offset_ms: number; now_ms: number }>("ntp_sync");
    variable.cache.time.offset = res.offset_ms;
    variable.cache.time.syncedTime = res.now_ms;
    variable.cache.time.lastSync = Date.now();
  } catch {
    // keep the previous offset on failure
  }
}
