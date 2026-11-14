/**
 * Boots every feature module. Mirrors the load order of the old
 * legacy/src/js/index/require.js. All subscriptions must be registered BEFORE
 * the map emits `MapLoad`, so call initFeatures() then setupMap().
 */
import { initAudio } from "@/lib/audioClient";
import { initAutostart } from "@/lib/autostartClient";
import { createLogger } from "@/lib/logger";
import { initPipBridge } from "@/lib/pipBridge";
import { initNotifications } from "@/lib/notificationClient";
import { initSpeech } from "@/lib/speechClient";

import { initEventLog } from "./log/eventLog";
import { initPlugins } from "./plugin";
import { initData } from "./data/data";
import { initResource } from "./data/resource";
import { initRts } from "./rts/rts";
import { initEew } from "./eew/eew";
import { initEstimate } from "./estimate/estimate";
import { initFocus } from "./focus/focus";
import { initCross } from "./cross/cross";
import { initBox } from "./box/box";
import { initIntensity } from "./intensity/intensity";
import { initLpgm } from "./lpgm/lpgm";
import { initReport } from "./report/report";
import { initLoop } from "./loop/loop";
import { initUpdate } from "./update/update";
import { initWindowControl } from "./window/window";

const log = createLogger("init");

function guard(name: string, fn: () => void) {
  try {
    fn();
  } catch (e) {
    log.error(`功能模組 ${name} 初始化失敗：`, e);
  }
}

export function initFeatures(): void {
  // First: every event is logged before any module acts on it.
  guard("event-log", initEventLog);
  // Then the extensions, before the modules that emit: V3 built its plugin
  // loader ahead of every feature (index/require.js), and a plugin that
  // subscribes to `DataRts` must hear the session's first frame.
  guard("plugin", initPlugins);
  guard("autostart", initAutostart);
  guard("audio", initAudio);
  guard("notifications", initNotifications);
  guard("speech", initSpeech);
  guard("resource", initResource);
  guard("focus", initFocus);
  guard("rts", initRts);
  guard("eew", initEew);
  guard("estimate", initEstimate);
  guard("cross", initCross);
  guard("box", initBox);
  guard("intensity", initIntensity);
  guard("lpgm", initLpgm);
  guard("report", initReport);
  guard("loop", initLoop);
  guard("pip", initPipBridge);
  // Register the attention/PiP handlers after their data producers, matching
  // legacy require order so content state is ready before a window is shown.
  guard("window", initWindowControl);
  guard("update", initUpdate);
  guard("data", initData);
}
