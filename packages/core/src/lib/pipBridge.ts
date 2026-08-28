/**
 * Main-window → PiP-window bridge. The PiP is a separate webview with its own JS
 * context, so it can't read `ui` directly; we emit the current EEW to it via a
 * Tauri event (replaces the old ipcRenderer 'update-pip').
 */
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

import { inTauri } from "./env";
import type { EewDisplay, RtsTriggerDisplay } from "./variable.ui";
import { ui } from "./variable.ui";
import { ensurePipWindow } from "./windows";

let last = "";
let initialized = false;
let pipReady = false;
let publishRevision = 0;
let lastRenderedRevision = 0;
const readyWaiters = new Set<() => void>();
const renderWaiters = new Map<number, () => void>();

type PipContent =
  | { noEew: true }
  | ({ noEew: false } & EewDisplay)
  | { noEew: false; trigger: RtsTriggerDisplay };

export type PipPayload = PipContent & { revision?: number };

function currentPayload(): PipContent {
  return ui.currentEew
    ? { noEew: false, ...ui.currentEew }
    : ui.currentTrigger
      ? { noEew: false, trigger: ui.currentTrigger }
      : { noEew: true };
}

interface PublishedPipState {
  revision: number;
  noEew: boolean;
  serialized: string;
}

async function publish(force = false): Promise<PublishedPipState | null> {
  if (!inTauri) return null;
  const payload = currentPayload();
  const serialized = JSON.stringify(payload);
  if (!force && serialized === last) return null;
  last = serialized;
  const revision = ++publishRevision;
  await emit("update-pip-content", { ...payload, revision });
  // Content updates and window visibility are separate in the legacy app.
  // Receiving an EEW/RTS payload must not make PiP appear while the main window
  // is visible (or merely because replay advanced to another frame).
  if (payload.noEew) await invoke("pip_hide").catch(() => {});
  return { revision, noEew: payload.noEew, serialized };
}

function waitForReady(timeoutMs = 2500): Promise<void> {
  if (pipReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timeout);
      readyWaiters.delete(done);
      resolve();
    };
    const timeout = window.setTimeout(() => {
      readyWaiters.delete(done);
      reject(new Error("PiP did not become ready"));
    }, timeoutMs);
    readyWaiters.add(done);
  });
}

function waitForRendered(revision: number, timeoutMs = 2500): Promise<void> {
  if (lastRenderedRevision >= revision) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timeout);
      renderWaiters.delete(revision);
      resolve();
    };
    const timeout = window.setTimeout(() => {
      renderWaiters.delete(revision);
      reject(new Error("PiP content was not rendered"));
    }, timeoutMs);
    renderWaiters.set(revision, done);
  });
}

export function hasPipContent(): boolean {
  return !currentPayload().noEew;
}

/** Show PiP only after the window controller has approved the timing. */
export async function showPipForCurrentAlert(
  canShow?: () => Promise<boolean>,
): Promise<boolean> {
  if (!inTauri || !hasPipContent()) return false;
  try {
    await ensurePipWindow();
    if (!pipReady) await emit("pip-sync-request");
    await waitForReady();

    // Content can rotate or end while the hidden window is becoming ready.
    // Republish until the acknowledged DOM matches the current source state.
    let current: PublishedPipState | null = null;
    let renderedCurrent = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      current = await publish(true);
      if (!current) break;
      await waitForRendered(current.revision);
      if (current.serialized === JSON.stringify(currentPayload())) {
        renderedCurrent = true;
        break;
      }
    }
    if (
      !current ||
      !renderedCurrent ||
      current.noEew ||
      current.serialized !== JSON.stringify(currentPayload()) ||
      !hasPipContent()
    ) {
      hidePip();
      return false;
    }
    if (canShow && !(await canShow())) {
      hidePip();
      return false;
    }
    await invoke("pip_show");
    return true;
  } catch {
    return false;
  }
}

export function hidePip(): void {
  if (!inTauri) return;
  void invoke("pip_hide").catch(() => {});
}

export function initPipBridge(): void {
  if (initialized) return;
  initialized = true;
  if (!inTauri) return;
  // Register the handshake before creating the hidden webview. PiP emits
  // `pip-ready` only after its content listener is active, preventing the first
  // state from being lost during webview startup.
  void Promise.all([
    listen("pip-ready", () => {
      pipReady = true;
      readyWaiters.forEach((resolve) => resolve());
      void publish(true);
    }),
    listen<{ revision: number }>("pip-rendered", (event) => {
      lastRenderedRevision = Math.max(lastRenderedRevision, event.payload.revision);
      for (const [revision, resolve] of renderWaiters) {
        if (revision <= lastRenderedRevision) resolve();
      }
    }),
  ])
    .then(() => ensurePipWindow())
    .then(() => emit("pip-sync-request"))
    .catch(() => {});
  window.setInterval(() => void publish(), 500);
}
