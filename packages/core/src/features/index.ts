/**
 * Boots every feature module. Mirrors the load order of the old
 * legacy/src/js/index/require.js. All subscriptions must be registered BEFORE
 * the map emits `MapLoad`, so call initFeatures() then setupMap().
 */
import { initAudio } from "@/lib/audioClient";
import { initAutostart } from "@/lib/autostartClient";
import { initHealth } from "@/lib/endpoints";
import { createLogger } from "@/lib/logger";
import { initPipBridge } from "@/lib/pipBridge";
import { initNotifications } from "@/lib/notificationClient";
import { initSpeech } from "@/lib/speechClient";
import { initUpdater } from "@/lib/updaterClient";

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
import { initWindowControl } from "./window/window";

const log = createLogger("init");

function guard(name: string, fn: () => void) {
  try {
    fn();
  } catch (e) {
    log.error(`${name}:`, e);
  }
}

export function initFeatures(): void {
  guard("health", initHealth);
  guard("autostart", initAutostart);
  guard("audio", initAudio);
  guard("notifications", initNotifications);
  guard("speech", initSpeech);
  guard("updater", initUpdater);
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
  guard("data", initData);
}
