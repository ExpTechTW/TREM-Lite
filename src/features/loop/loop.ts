// Ported from legacy/src/js/index/core/loop.js
// The #time text + internet-warning DOM move to React overlays; this drives the
// map flash (cross/box), the internet-error flag, and periodic NTP sync (Rust).
import { LAST_DATA_TIMEOUT_ERROR } from "@/lib/constants";
import { events } from "@/lib/events";
import { syncNtp } from "@/lib/ntp";
import { ui } from "@/lib/variable.ui";
import { variable } from "@/lib/variable";

import { refresh_box } from "@/features/box/box";
import { refresh_cross } from "@/features/cross/cross";

let flash = false;
let mapInitialized = false;
let mapLoopInterval: ReturnType<typeof setInterval> | null = null;

export function initLoop(): void {
  // 1s 斷線偵測（沒有資料事件可依賴，故仍需週期檢查）；只有旗標改變時才發事件。
  setInterval(() => {
    const err =
      variable.play_mode !== 2 &&
      variable.play_mode !== 3 &&
      Date.now() - variable.cache.last_data_time > LAST_DATA_TIMEOUT_ERROR;
    if (err !== ui.internetError) {
      ui.internetError = err;
      events.emit("InternetErrorChange", err);
    }
  }, 1000);

  // 單一 500ms 閃爍節拍：直接刷新 cross/box，並廣播 Flash 給其他模組（如 eew 波前），
  // 取代各自重複的計時器。
  events.on("MapLoad", () => {
    if (mapInitialized) return;
    mapInitialized = true;
    if (mapLoopInterval) clearInterval(mapLoopInterval);
    mapLoopInterval = setInterval(() => {
      flash = !flash;
      events.emit("Flash", flash);
      refresh_cross(flash);
      refresh_box(flash);
    }, 500);
  });

  // NTP sync now + every minute (done in Rust).
  void syncNtp();
  setInterval(() => void syncNtp(), 60000);
}
