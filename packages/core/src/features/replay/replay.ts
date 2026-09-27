// Ported from legacy/src/js/index/core/replay.js
//
// A report's replay. Entering and leaving go through the same switch as the
// file replay (DataManager.switchMode), so either way every piece of state —
// data, alert caches, the RTS ranking and trigger history, overlays, sounds —
// starts clean on the other side.
//
// It leaves by itself once it has run REPLAY_MAX_MS, just as if its button
// had been pressed again.
import { events } from "@/lib/events";
import { now } from "@/lib/ntp";
import { variable } from "@/lib/variable";

import { switchPlayMode } from "@/features/data/data";
import { focus, focus_reset, isAutoFocusLocked } from "@/features/focus/focus";

/**
 * How long a replay runs. Everything in it is over by then: a shake report,
 * the longest lived, ends 600 s after its shake.
 */
const REPLAY_MAX_MS = 600_000;

let timeLimit: ReturnType<typeof setInterval> | null = null;

function clearTimeLimit(): void {
  if (timeLimit) clearInterval(timeLimit);
  timeLimit = null;
}

export function startReplay(time: number, reportId?: string): void {
  switchPlayMode(2, { start_time: Number(time), local_time: 0, dev: false });
  events.emit("ReplayStateChange", { active: true, ...(reportId ? { reportId } : {}) });
  clearTimeLimit();
  timeLimit = setInterval(() => {
    if (variable.play_mode !== 2) {
      clearTimeLimit();
      return;
    }
    // Read on the replay's own clock, so a machine that slept through part of
    // the replay still leaves it at 600 s of replay.
    if (now() - variable.replay.start_time > REPLAY_MAX_MS) stopReplay();
  }, 1000);
}

export function stopReplay(): void {
  clearTimeLimit();
  switchPlayMode(0, { start_time: 0, local_time: 0, dev: false });
  events.emit("ReplayStateChange", { active: false });
  if (!isAutoFocusLocked()) {
    setTimeout(() => {
      focus_reset();
      focus();
    }, 1500);
  }
}
