// Ported from legacy/src/js/index/core/replay.js
import { events } from "@/lib/events";
import { variable } from "@/lib/variable";

import { abortAll } from "@/features/data/dataHttp";
import { focus, focus_reset, isAutoFocusLocked } from "@/features/focus/focus";

function clear() {
  abortAll();
  variable.cache.last_data_time = 0;
  variable.data.rts = null;
  variable.replay = { start_time: 0, local_time: 0, dev: false };
}

export function startReplay(time: number): void {
  clear();
  variable.replay = { start_time: Number(time), local_time: 0, dev: false };
  variable.play_mode = 2;
}

export function stopReplay(): void {
  variable.data.eew.forEach((d) => {
    d.EewEnd = true;
  });
  (variable.data.intensity as { IntensityEnd?: number }[]).forEach((d) => (d.IntensityEnd = 1));
  clear();
  variable.cache.int_cache_list = {};
  variable.play_mode = 0;
  variable.cache.unstable = 0;
  variable.cache.intensity_last = {};
  events.emit("DataRts", { info: { type: variable.play_mode }, data: null });
  variable.cache.intensity = { time: 0, max: 0 };
  variable.cache.last_rts_alert = 0;
  if (!isAutoFocusLocked()) {
    setTimeout(() => {
      focus_reset();
      focus();
    }, 1500);
  }
}
