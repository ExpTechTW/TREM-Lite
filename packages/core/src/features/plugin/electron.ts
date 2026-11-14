/**
 * `require("electron")` for an extension running in the main window.
 *
 * V3 extensions reach for `ipcRenderer` for exactly two things: opening a
 * window of their own, and pushing data into it. Both are answered by
 * `src-tauri/src/plugin_window.rs` — the window is a real Tauri window, the
 * data arrives through `WebviewWindow::eval` — so to a plugin this looks like
 * the Electron it was written against.
 *
 * The four channels Rust sends back are dispatched here, because a plugin's
 * `web/` page is the thing that talks to the *window*, while the plugin's own
 * `index.js` is the thing that listens for `plugin-window-closed`. Reusing the
 * V3 names is what makes that work without a compatibility table.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";

import { inTauri } from "@/lib/env";
import { createLogger } from "@/lib/logger";

const log = createLogger("plugin");

type Handler = (event: { sender: string }, payload: unknown) => void;

const listeners = new Map<string, Handler[]>();
let wired = false;

function emit(channel: string, payload: unknown, sender = ""): void {
  for (const handler of [...(listeners.get(channel) ?? [])]) {
    try {
      handler({ sender }, payload);
    } catch (e) {
      log.error(`擴充功能的事件處理失敗（${channel}）：`, e);
    }
  }
}

/** Subscribe once, on the first plugin that asks for `electron`. */
function wire(): void {
  if (wired || !inTauri) return;
  wired = true;
  void listen<{ pluginId: string; channel: string; payload: unknown }>("plugin-window-message", (event) => {
    emit(event.payload.channel, event.payload.payload, event.payload.pluginId);
  });
  for (const channel of ["plugin-window-opened", "plugin-window-closed", "plugin-windows-list"]) {
    void listen<unknown>(channel, (event) => emit(channel, event.payload));
  }
}

export interface IpcRenderer {
  send(channel: string, ...args: unknown[]): void;
  sendSync(channel: string, ...args: unknown[]): null;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, handler: Handler): IpcRenderer;
  once(channel: string, handler: Handler): IpcRenderer;
  off(channel: string, handler: Handler): IpcRenderer;
  removeListener(channel: string, handler: Handler): IpcRenderer;
  removeAllListeners(channel?: string): IpcRenderer;
}

/**
 * The `ipcRenderer` one plugin sees. `plugin` names the sender, so a message
 * aimed at "my window" can be routed without the plugin knowing a window id.
 */
export function ipcRendererFor(plugin: string): IpcRenderer {
  wire();
  const send = (channel: string, args: unknown[]): Promise<unknown> => {
    if (!inTauri) return Promise.resolve(null);
    const payload = args.length === 0 ? null : args.length === 1 ? args[0] : args;
    return invoke("plugin_window_ipc", { plugin, channel, payload, source: "main" }).catch((e: unknown) => {
      log.warn(`擴充功能 ${plugin} 的 ${channel} 沒有完成：${String(e)}`);
      return null;
    });
  };
  const add = (channel: string, handler: Handler, once: boolean): IpcRenderer => {
    const entry: Handler = once
      ? (event, payload) => {
          ipcRenderer.removeListener(channel, entry);
          handler(event, payload);
        }
      : handler;
    listeners.set(channel, [...(listeners.get(channel) ?? []), entry]);
    return ipcRenderer;
  };
  const ipcRenderer: IpcRenderer = {
    send: (channel, ...args) => {
      void send(channel, args);
    },
    sendSync: (channel, ...args) => {
      void send(channel, args);
      return null;
    },
    invoke: (channel, ...args) => send(channel, args),
    on: (channel, handler) => add(channel, handler, false),
    once: (channel, handler) => add(channel, handler, true),
    off: (channel, handler) => ipcRenderer.removeListener(channel, handler),
    removeListener: (channel, handler) => {
      listeners.set(channel, (listeners.get(channel) ?? []).filter((item) => item !== handler));
      return ipcRenderer;
    },
    removeAllListeners: (channel) => {
      if (channel) listeners.delete(channel);
      else listeners.clear();
      return ipcRenderer;
    },
  };
  return ipcRenderer;
}

/**
 * The rest of the Electron surface a plugin is likely to touch. `shell` goes
 * through the opener plugin, so it opens things the way the app does.
 */
export function electronModule(plugin: string) {
  return {
    ipcRenderer: ipcRendererFor(plugin),
    contextBridge: {
      exposeInMainWorld: (key: string, value: unknown) => {
        (window as unknown as Record<string, unknown>)[key] = value;
      },
    },
    shell: {
      openPath: (path: string) => openPath(path),
      openExternal: (url: string) => openUrl(url),
    },
    remote: undefined,
    default: undefined,
  };
}
