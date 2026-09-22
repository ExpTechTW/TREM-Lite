/**
 * 統一日誌介面。
 *
 * 底層走 tauri-plugin-log（`@tauri-apps/plugin-log`）：日誌會流到 Rust 端寫入
 * app log 目錄的檔案，帶分級與本地時區毫秒時間戳、按大小滾轉、保留 7 天
 * （見 src-tauri/src/logging.rs）。在純瀏覽器（headless WebKit debug harness）
 * 或 dev 模式下，同時輸出到 console（帶時間戳）方便即時查看。
 *
 * 用法：`const log = createLogger("map"); log.info("ready");`
 */
import { inTauri } from "./env";

type Level = "trace" | "debug" | "info" | "warn" | "error";

const DEV = import.meta.env.DEV;

// plugin-log 只在 Tauri 環境動態載入（瀏覽器 harness 沒有 Tauri 後端）。
type LogFns = Record<Level, (msg: string) => Promise<void>>;
let sink: LogFns | null = null;
let sinkReady: Promise<void> = Promise.resolve();
if (inTauri) {
  sinkReady = import("@tauri-apps/plugin-log")
    .then((m) => {
      sink = { trace: m.trace, debug: m.debug, info: m.info, warn: m.warn, error: m.error };
    })
    .catch(() => {
      /* 載入失敗就只走 console */
    });
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// release build 的 Rust 端只收 Info 以上（logging.rs），trace/debug 送過去也會被丟棄，
// 所以不必付出 stringify 與每行一次 IPC 的成本；寫進檔案的內容完全相同。
const DROPPED_BY_RUST: ReadonlySet<Level> = new Set(DEV ? [] : ["trace", "debug"]);

function emit(level: Level, scope: string, args: unknown[]): void {
  // 寫檔（經 Rust）。即使 sink 尚未載入完成，也會在載入後補寫。
  if (inTauri && !DROPPED_BY_RUST.has(level)) {
    const msg = `[${scope}] ${args.map(stringify).join(" ")}`;
    void sinkReady.then(() => sink?.[level]?.(msg));
  }

  // dev / 瀏覽器：同步輸出 console（帶毫秒時間戳）。
  if (DEV || !inTauri) {
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    const head = `${ts} [${scope}]`;
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
