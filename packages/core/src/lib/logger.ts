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
 * console。未捕捉的錯誤與沒人接的 promise rejection 也會記下，每個視窗各自記。
 */
import { invoke } from "@tauri-apps/api/core";

import { inTauri } from "./env";
import { appendLine, startLogStore } from "./logStore";

type Level = "trace" | "debug" | "info" | "warn" | "error";

const DEV = import.meta.env.DEV;

/** 一行最多幾個字：誤把整份測站表丟進日誌時，不該一次寫進幾百 KB。 */
const MAX_MESSAGE = 16 * 1024;

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
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
    let message = args.map(stringify).join(" ");
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
    if (level === "error") console.error(head, ...args);
    else if (level === "warn") console.warn(head, ...args);
    else console.log(head, ...args);
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

if (typeof window !== "undefined") {
  const log = createLogger("error");
  window.addEventListener("error", (event) => {
    const where = event.filename ? ` @ ${event.filename}:${event.lineno}:${event.colno}` : "";
    log.error(`未捕捉的錯誤${where}：`, event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    log.error("沒人處理的 promise rejection：", event.reason);
  });

  const store = createLogger("logging");
  startLogStore(({ zipped, removed }) => {
    if (removed) store.info(`清掉 ${removed} 個小時份的舊日誌`);
    if (zipped) store.info(`壓縮 ${zipped} 個已封存的日誌`);
  });
}

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
