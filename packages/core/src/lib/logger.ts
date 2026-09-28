/**
 * 統一日誌介面：`const log = createLogger("sse"); log.info("已連線");`
 *
 * 格式、歸檔與壓縮照 trem-monitor：每行 `[HH:MM:SS.mmm][LEVEL][模組]: 訊息`，每
 * 小時一份，過了的小時壓成 gzip，保留 7 天。
 *
 *   desktop  送到 Rust（src-tauri/src/logging.rs），和 Rust 自己的日誌寫進同一個
 *            {app_data_dir}/logs/YYYY/MM/DD/HH.log
 *   web      存在 localStorage（logStore.ts），同樣的格式與規則
 *
 * 寫下的是 DEBUG 以上；TRACE 只在開發時印到 console。網頁版與開發時每行也印到
 * console。
 *
 * 全域攔截照 trem-monitor（src/lib/log.ts），這個模組一載入就掛上——比任何會記
 * 日誌的模組都早，每個視窗（主視窗、設定、PiP）各自掛：未捕捉的錯誤、資源載入
 * 失敗、沒人接的 promise rejection、console.error／warn，以及 React 的根錯誤
 * （`reactRootErrorHandlers`，交給 createRoot）。這些都記在 `web` 底下，並且限流：
 * 同一則 5 秒內重複只記次數，每 10 秒最多 30 則。各模組自己寫的日誌不限流——
 * 一次地震幾秒內就有幾十行，每一行都要留。
 */
import { invoke } from "@tauri-apps/api/core";

import { inTauri } from "./env";
import { appendLine, startLogStore } from "./logStore";

type Level = "trace" | "debug" | "info" | "warn" | "error";

const DEV = import.meta.env.DEV;

/** 一行最多幾個字（同 trem-monitor）：誤把整份測站表丟進日誌時，不該一次寫進幾百 KB。 */
const MAX_MESSAGE = 8_000;

/** 原本的 console：這個模組自己印的，不能繞回攔截再記一次。 */
const rawConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

/** 任何東西 → 一段看得懂的文字；Error 帶上 stack 與 cause。 */
export function describe(value: unknown): string {
  if (value instanceof Error) {
    const head = `${value.name}: ${value.message}`;
    const stack = value.stack ?? "";
    // Chromium 的 stack 第一行就是 "Name: message"，WebKit（macOS）的只有呼叫鏈。
    const body = stack.startsWith(head) ? stack : `${head}${stack ? `\n${stack}` : ""}`;
    return value.cause === undefined ? body : `${body}\n原因：${describe(value.cause)}`;
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `[HH:MM:SS.mmm][LEVEL][模組]: 訊息`，與 Rust 端寫出來的一模一樣。 */
export function formatLine(t: number, level: Level, scope: string, message: string): string {
  const d = new Date(t);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  return `[${time}][${level.toUpperCase()}][${scope}]: ${message}\n`;
}

/** 送往 Rust 的一行：時間、等級、模組、訊息（欄位名縮短，因為每行都要送）。 */
interface WireLine {
  t: number;
  l: Level;
  s: string;
  m: string;
}

let pending: WireLine[] = [];

function send(): void {
  const lines = pending;
  pending = [];
  void invoke("log_write", { lines }).catch(() => {
    /* 寫不進去也不能讓日誌自己變成錯誤來源 */
  });
}

function emit(level: Level, scope: string, args: unknown[]): void {
  const t = Date.now();
  if (level !== "trace") {
    let message = args.map(describe).join(" ");
    if (message.length > MAX_MESSAGE) {
      message = `${message.slice(0, MAX_MESSAGE)}…（截斷，原長 ${message.length} 字）`;
    }
    if (inTauri) {
      // 同一個工作階段裡的行合成一次 IPC；用 microtask 而不是計時器，隱藏的
      // 視窗裡也不會被延後。
      if (!pending.length) queueMicrotask(send);
      pending.push({ t, l: level, s: scope, m: message });
    } else {
      appendLine(formatLine(t, level, scope, message));
    }
  }

  if ((DEV || !inTauri) && (level !== "trace" || DEV)) {
    const head = formatLine(t, level, scope, "").slice(0, -2);
    if (level === "error") rawConsole.error(head, ...args);
    else if (level === "warn") rawConsole.warn(head, ...args);
    else rawConsole.log(head, ...args);
  }
}

export interface Logger {
  trace: (...a: unknown[]) => void;
  debug: (...a: unknown[]) => void;
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
}

/** 建立帶模組標籤的 logger。 */
export function createLogger(scope: string): Logger {
  return {
    trace: (...a: unknown[]) => emit("trace", scope, a),
    debug: (...a: unknown[]) => emit("debug", scope, a),
    info: (...a: unknown[]) => emit("info", scope, a),
    warn: (...a: unknown[]) => emit("warn", scope, a),
    error: (...a: unknown[]) => emit("error", scope, a),
  };
}

// ─── 全域攔截（照 trem-monitor 的 src/lib/log.ts）────────────────────────────

/** 限流：一個錯誤在每一幀重複丟時，不能把日誌和 IPC 洗爆。 */
const BURST = 30;
const WINDOW_MS = 10_000;
/** 同一則訊息在這段時間內重複出現，只記次數。 */
const REPEAT_MS = 5_000;

let windowStart = -Infinity;
let sentInWindow = 0;
let dropped = 0;
let last: { key: string; at: number; repeats: number } | null = null;
let repeatTimer: ReturnType<typeof setTimeout> | undefined;

type Caught = "info" | "warn" | "error";

/** 攔截到的東西都記在 `web` 底下，與各模組自己的日誌分開。 */
const put = (level: Caught, message: string) => emit(level, "web", [message]);

/** 把累積的重複次數寫出去。 */
function flushRepeats(): void {
  clearTimeout(repeatTimer);
  repeatTimer = undefined;
  if (last && last.repeats > 0) {
    put("info", `（上一則又重複了 ${last.repeats} 次）`);
    last.repeats = 0;
  }
}

/** 限流後寫下一則攔截到的訊息。 */
function caught(level: Caught, message: string): void {
  const now = performance.now();
  const key = `${level}|${message}`;
  if (last && last.key === key && now - last.at < REPEAT_MS) {
    last.repeats += 1;
    last.at = now;
    // 重複到一半就停的話，也要有人把次數記下來。
    repeatTimer ??= setTimeout(flushRepeats, REPEAT_MS);
    return;
  }
  flushRepeats();
  last = { key, at: now, repeats: 0 };

  if (now - windowStart >= WINDOW_MS) {
    if (dropped > 0) put("warn", `（限流：前 ${WINDOW_MS / 1000} 秒丟掉 ${dropped} 則）`);
    windowStart = now;
    sentInWindow = 0;
    dropped = 0;
  }
  if (sentInWindow >= BURST) {
    dropped += 1;
    return;
  }
  sentInWindow += 1;
  put(level, message);
}

/** 這個視窗是哪一個，給載入那行。 */
function windowName(): string {
  const page = location.pathname.split("/").pop() ?? "";
  if (page.startsWith("settings")) return "設定視窗";
  if (page.startsWith("pip")) return "PiP 視窗";
  if (page.startsWith("preview")) return "預覽頁";
  return "主視窗";
}

let installed = false;

/** 掛上全域攔截。這個模組載入時就會呼叫，重複呼叫沒有作用。 */
export function installGlobalLogging(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  // 執行期錯誤（事件在 window 上）與資源載入失敗（事件在元素上、不冒泡，要用 capture）
  window.addEventListener(
    "error",
    (event) => {
      const target = event.target;
      if (target instanceof Element) {
        const src = target.getAttribute("src") ?? target.getAttribute("href") ?? "";
        caught("error", `資源載入失敗：<${target.tagName.toLowerCase()}> ${src}`);
        return;
      }
      const where = event.filename ? `（${event.filename}:${event.lineno}:${event.colno}）` : "";
      caught("error", `未捕捉的錯誤${where}：${describe(event.error ?? event.message)}`);
    },
    true,
  );

  window.addEventListener("unhandledrejection", (event) => {
    caught("error", `沒人處理的 promise rejection：${describe(event.reason)}`);
  });

  // 既有的 console.error／warn（MapLibre 的警告、第三方套件的錯誤）也一起落地。
  for (const level of ["error", "warn"] as const) {
    const original = rawConsole[level];
    console[level] = (...args: unknown[]) => {
      original(...args);
      caught(level, args.map(describe).join(" "));
    };
  }

  emit("info", "app", [
    [
      `${windowName()}載入｜${inTauri ? "桌面版" : `網頁版 ${location.origin}${location.pathname}`}`,
      `視窗 ${innerWidth}×${innerHeight}，螢幕 ${screen.width}×${screen.height} @${devicePixelRatio}x`,
      `語系 ${navigator.language}，時區 ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
      navigator.onLine ? "連線中" : "離線",
      navigator.userAgent,
    ].join("｜"),
  ]);

  const store = createLogger("logging");
  startLogStore(({ zipped, removed }) => {
    if (removed) store.info(`清掉 ${removed} 個小時份的舊日誌`);
    if (zipped) store.info(`壓縮 ${zipped} 個已封存的日誌`);
  });
}

/** React 元件層級，接在錯誤後面，看得出是哪個元件出錯。 */
const where = (info: { componentStack?: string }) => (info.componentStack ? `\n元件層級：${info.componentStack}` : "");

/**
 * React 19 的根錯誤回呼，交給每個視窗的 createRoot：畫面整個卸載、錯誤被
 * error boundary 接住、React 自動復原，日誌裡都看得到是哪個元件。
 */
export const reactRootErrorHandlers = {
  onUncaughtError(error: unknown, info: { componentStack?: string }) {
    rawConsole.error(error);
    caught("error", `React 未捕捉的錯誤，畫面已卸載：${describe(error)}${where(info)}`);
  },
  onCaughtError(error: unknown, info: { componentStack?: string }) {
    rawConsole.error(error);
    caught("error", `React error boundary 接到錯誤：${describe(error)}${where(info)}`);
  },
  onRecoverableError(error: unknown, info: { componentStack?: string }) {
    rawConsole.warn(error);
    caught("warn", `React 自動復原的錯誤：${describe(error)}${where(info)}`);
  },
};

installGlobalLogging();

/** 時間長度，照 trem-monitor：`850ms`、`1.2s`、`3m05s`、`2h10m`。 */
export function fmtDur(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 1) return `${Math.max(0, Math.round(ms))}ms`;
  if (secs < 60) return `${(ms / 1000).toFixed(1)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m${pad(secs % 60)}s`;
  return `${Math.floor(secs / 3600)}h${pad(Math.floor((secs % 3600) / 60))}m`;
}

/** 大小，照 trem-monitor：`512 B`、`1.2 KB`、`3.4 MB`。 */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1_048_576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1_048_576).toFixed(1)} MB`;
}
