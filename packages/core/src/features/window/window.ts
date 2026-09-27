/**
 * Native window attention controller. This is the Tauri counterpart of
 * legacy/src/js/index/core/window.js: alert events respect the same four
 * settings and bring the main window back to the foreground.
 */
import { invoke } from "@tauri-apps/api/core";

import { getConfig } from "@/lib/config";
import { inTauri } from "@/lib/env";
import { events } from "@/lib/events";
import { hasPipContent, hidePip, showPipForCurrentAlert } from "@/lib/pipBridge";

let initialized = false;
let mainUnavailable = false;
let checkingVisibility = false;

function enabled(key: string): boolean {
  return !!getConfig()["check-box"][key];
}

/**
 * Every event the main window can be brought forward for. Each also hides the
 * settings window — whatever the four settings say, since what is on the map
 * then matters more than the page on top of it. It reopens from the nav bar.
 */
const MAIN_EVENTS = [
  "EewRelease",
  "EewAlert",
  "EewNewAreaAlert",
  "RtsPga2",
  "RtsPga1",
  "RtsShindo2",
  "RtsShindo1",
  "RtsShindo0",
  "ReportRelease",
  "IntensityRelease",
  "LpgmRelease",
  "TsunamiRelease",
] as const;

function hideSettings(): void {
  void invoke("window_hide", { label: "settings" }).catch(() => {});
}

function focusMain(critical = false): void {
  if (!inTauri) return;
  void invoke("window_request_attention", { critical }).catch(() => {});
  void invoke("window_focus").catch(() => {});
}

async function isMainUnavailable(): Promise<boolean> {
  if (!inTauri) return false;
  const [visible, minimized] = await invoke<[boolean, boolean]>("window_state", { label: "main" });
  return !visible || minimized;
}

/**
 * Legacy shows PiP as a substitute only while the main window is hidden or
 * minimized. The async visibility read also lets the originating EEW/RTS
 * handler finish updating PiP content before it is displayed.
 */
function surfaceAlert(critical: boolean, pipEligible: boolean): void {
  if (!inTauri) return;
  void (async () => {
    try {
      if (pipEligible && (await isMainUnavailable())) {
        if (await showPipForCurrentAlert(isMainUnavailable)) return;
      }
    } catch {
      // Fall through to the normal attention path if native state is unavailable.
    }
    hidePip();
    focusMain(critical);
  })();
}

async function syncVisibilityTransition(): Promise<void> {
  if (checkingVisibility) return;
  checkingVisibility = true;
  try {
    const unavailable = await isMainUnavailable();
    if (unavailable !== mainUnavailable) events.emit("MainWindowHidden", unavailable);
    if (!unavailable) {
      mainUnavailable = false;
      // Enforce the invariant, not only the transition: a delayed handshake or
      // another caller must never leave PiP beside a visible main window.
      hidePip();
      return;
    }
    if (mainUnavailable) return;
    mainUnavailable = true;
    if (hasPipContent()) await showPipForCurrentAlert(isMainUnavailable);
  } catch {
    // A transient native query failure is retried by the next interval.
  } finally {
    checkingVisibility = false;
  }
}

/** Register every event listed by legacy WINDOW_FOCUS_EVENTS. */
export function initWindowControl(): void {
  if (initialized) return;
  initialized = true;

  events.on("EewRelease", () => {
    if (enabled("show-window-eew")) surfaceAlert(true, true);
  });
  events.on("EewAlert", () => {
    if (enabled("show-window-eew")) surfaceAlert(true, true);
  });
  events.on("EewNewAreaAlert", () => {
    if (enabled("show-window-eew")) surfaceAlert(true, true);
  });

  events.on("RtsPga2", () => {
    if (enabled("show-window-detect")) surfaceAlert(true, false);
  });
  events.on("RtsPga1", () => {
    if (enabled("show-window-detect")) surfaceAlert(false, false);
  });
  events.on("RtsShindo2", () => {
    if (enabled("show-window-detect")) surfaceAlert(true, true);
  });
  events.on("RtsShindo1", () => {
    if (enabled("show-window-detect")) surfaceAlert(false, true);
  });
  events.on("RtsShindo0", () => {
    if (enabled("show-window-detect")) surfaceAlert(false, true);
  });

  events.on("ReportRelease", () => {
    if (enabled("show-window-report")) surfaceAlert(false, false);
  });
  events.on("IntensityRelease", () => {
    if (enabled("show-window-rts-intensity")) surfaceAlert(true, false);
  });
  events.on("LpgmRelease", () => {
    if (enabled("show-window-rts-intensity")) surfaceAlert(true, false);
  });

  // Legacy always surfaced tsunami alerts, independent of the four toggles.
  events.on("TsunamiRelease", () => surfaceAlert(true, true));

  if (inTauri) for (const name of MAIN_EVENTS) events.on(name, hideSettings);

  if (inTauri) {
    void isMainUnavailable()
      .then((unavailable) => {
        mainUnavailable = unavailable;
        // Started to the tray (`--start`): the stream sleeps from the outset.
        if (unavailable) events.emit("MainWindowHidden", true);
      })
      .catch(() => {});
    window.setInterval(() => void syncVisibilityTransition(), 500);
  }
}
