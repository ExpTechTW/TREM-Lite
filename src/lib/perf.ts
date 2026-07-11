/**
 * 啟動載入計時。在關鍵里程碑呼叫 `mark()`，輸出「距啟動 +Xms（Δ自上個里程碑）」，
 * 用來分析載入慢在哪一步。里程碑同時寫進日誌檔（見 logger.ts）。
 *
 * 典型序列：boot → config-loaded → features-init → map-ready → station-loaded
 * → sse-rts-connected → report-loaded。相鄰里程碑的 Δ 就是各階段耗時。
 */
import { createLogger } from "./logger";

const log = createLogger("perf");
// performance.now() 以頁面開始載入為基準，接近真正的啟動起點。
const t0 = performance.now();
let last = t0;
const seen = new Set<string>();

/** 記錄一個里程碑。同名只記第一次（避免輪詢／重連洗版）。 */
export function mark(name: string): void {
  if (seen.has(name)) return;
  seen.add(name);
  const now = performance.now();
  log.info(`${name} +${Math.round(now - t0)}ms (Δ${Math.round(now - last)}ms)`);
  last = now;
}
