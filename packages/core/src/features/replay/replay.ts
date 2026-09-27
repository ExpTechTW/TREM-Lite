// Ported from legacy/src/js/index/core/replay.js
//
// A report's replay. Entering and leaving go through the same switch as the
// file replay (DataManager.switchMode), so either way every piece of state —
// data, alert caches, the RTS ranking and trigger history, overlays, sounds —
// starts clean on the other side.
import { events } from "@/lib/events";

import { switchPlayMode } from "@/features/data/data";
import { focus, focus_reset, isAutoFocusLocked } from "@/features/focus/focus";

export function startReplay(time: number, reportId?: string): void {
  switchPlayMode(2, { start_time: Number(time), local_time: 0, dev: false });
  events.emit("ReplayStateChange", { active: true, ...(reportId ? { reportId } : {}) });
}

export function stopReplay(): void {
  switchPlayMode(0, { start_time: 0, local_time: 0, dev: false });
  events.emit("ReplayStateChange", { active: false });
  if (!isAutoFocusLocked()) {
    setTimeout(() => {
      focus_reset();
      focus();
    }, 1500);
  }
}
