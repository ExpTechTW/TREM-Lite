/**
 * 把事件匯流排上發生的事記進日誌：預警、震度速報、長週期、報告、測站警報、
 * 重播、視窗、更新……所有模組的事件都經過這裡，一個訂閱就涵蓋全部。
 *
 * 有描述的事件各自註冊，而且最先註冊（features/index.ts），所以日誌裡先看到
 * 「發生了什麼」，再看到各模組因此做了什麼（音效、語音、視窗）。沒有描述的事件
 * 由萬用字元接住、以 DEBUG 記下名稱，新加的事件不會悄悄漏記。
 *
 * DataRts 一秒兩筆，逐筆記會淹沒其他內容：觸發的測站或最大震度、最大加速度改變
 * 時記一行，另外每分鐘記一行摘要。
 */
import { search_loc_name } from "@/domain/utils";
import { INTENSITY_LIST } from "@/lib/constants";
import { events, type TremEvents } from "@/lib/events";
import { createLogger } from "@/lib/logger";
import type { EewData, ReportListItem, RtsData } from "@/lib/types";
import { variable } from "@/lib/variable";

const log = createLogger("event");

const pad = (n: number) => String(n).padStart(2, "0");

/** `MM/DD HH:mm:ss`，本地時間。 */
function when(t: number | undefined): string {
  if (!t) return "?";
  const d = new Date(t);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const shindo = (i: number | undefined) => (i == null ? "?" : (INTENSITY_LIST[i] ?? String(i)));

/** 事件的 `info.type`：0 即時，2 報告重播，3 檔案重播。 */
function mode(ans: { [k: string]: unknown }): string {
  const type = (ans.info as { type?: number } | undefined)?.type;
  return type === 2 ? "〔報告重播〕" : type === 3 ? "〔檔案重播〕" : "";
}

const EEW_STATUS: Record<number, string> = { 0: "預警", 1: "警報", 3: "取消" };

function eew(kind: string, ans: { data: EewData; [k: string]: unknown }): string {
  const e = ans.data;
  const eq = e.eq ?? ({} as EewData["eq"]);
  return [
    `${mode(ans)}${kind} ${e.id} 第 ${e.serial} 報`,
    `${e.author} ${EEW_STATUS[e.status] ?? `status ${e.status}`}${e.final ? "（最終報）" : ""}`,
    `${eq.loc ?? "?"} (${eq.lat}, ${eq.lon})`,
    `M${eq.mag} 深 ${eq.depth} km`,
    `預估最大 ${shindo(eq.max)}`,
    `發震 ${when(eq.time)}`,
  ].join("｜");
}

/** `{ 震度: [鄉鎮代碼] }` → 各震度幾個鄉鎮，最高的那級列出地名。 */
function areas(area: Record<number, number[]> | undefined): string {
  if (!area) return "無區域資料";
  const levels = Object.keys(area)
    .map(Number)
    .sort((a, b) => b - a);
  if (!levels.length) return "無區域資料";
  const counts = levels.map((i) => `${shindo(i)}×${area[i].length}`).join(" ");
  const top = area[levels[0]]
    .slice(0, 12)
    .map((code) => {
      const place = search_loc_name(code);
      return place ? `${place.city}${place.town}` : String(code);
    })
    .join("、");
  const more = area[levels[0]].length > 12 ? ` 等 ${area[levels[0]].length} 處` : "";
  return `${counts}｜${shindo(levels[0])}：${top}${more}`;
}

function report(r: ReportListItem, update?: boolean): string {
  return [
    `地震報告${update ? "（修正）" : ""} ${r.id}`,
    `${r.loc} (${r.lat}, ${r.lon})`,
    `M${r.mag} 深 ${r.depth} km`,
    `最大 ${shindo(r.int)}`,
    `發震 ${when(r.time)}`,
  ].join("｜");
}

/** 測站代碼 → 所在鄉鎮。 */
function stationPlace(id: string): string {
  const code = variable.station?.[id]?.info.at(-1)?.code;
  const place = code ? search_loc_name(code) : null;
  return place ? `${place.city}${place.town}` : "?";
}

/** 一筆 RTS 的觸發狀況。 */
function rtsState(rts: RtsData) {
  const stations = Object.entries(rts.station ?? {});
  const alerted = stations.filter(([, s]) => s.alert);
  let maxI = -1;
  let maxPga = 0;
  for (const [, s] of alerted) {
    maxI = Math.max(maxI, s.i);
    maxPga = Math.max(maxPga, s.pga);
  }
  return { stations: stations.length, alerted, maxI, maxPga, boxes: Object.keys(rts.box ?? {}).length };
}

/** 每分鐘一行的 RTS 摘要，與觸發狀況改變時的一行。 */
function rtsLog() {
  let frames = 0;
  let windowStart = Date.now();
  let lastKey = "";
  return (rts: RtsData | null) => {
    if (!rts) {
      if (lastKey) log.info("RTS 清空（模式切換或資料重設）");
      lastKey = "";
      return;
    }
    frames++;
    const s = rtsState(rts);
    const key = `${s.alerted.length}|${Math.round(s.maxI)}|${Math.round(s.maxPga)}|${s.boxes}`;
    if (key !== lastKey) {
      if (s.alerted.length) {
        const top = [...s.alerted]
          .sort(([, a], [, b]) => b.i - a.i || b.pga - a.pga)
          .slice(0, 5)
          .map(([id, st]) => `${id} ${stationPlace(id)} 震度 ${st.i.toFixed(1)} PGA ${st.pga.toFixed(1)}`)
          .join("；");
        log.info(
          `RTS 觸發 ${s.alerted.length} 站｜最大震度 ${s.maxI.toFixed(1)}｜最大 PGA ${s.maxPga.toFixed(1)} gal｜警戒框 ${s.boxes} 區｜${top}`,
        );
      } else if (lastKey && !lastKey.startsWith("0|")) {
        log.info("RTS 觸發結束，沒有測站在警戒中");
      }
      lastKey = key;
    }
    const now = Date.now();
    if (now - windowStart >= 60_000) {
      const lag = rts.time ? ((now - rts.time) / 1000).toFixed(1) : "?";
      log.debug(
        `RTS 近 ${Math.round((now - windowStart) / 1000)} 秒 ${frames} 筆｜回報測站 ${s.stations}｜觸發 ${s.alerted.length}｜資料時間 ${when(rts.time)}（落後 ${lag} 秒）`,
      );
      frames = 0;
      windowStart = now;
    }
  };
}

/** 各事件怎麼記。 */
type Describe = { [K in keyof TremEvents]?: (payload: TremEvents[K]) => void };

const RTS_SOUND: Record<string, string> = {
  RtsShindo0: "測站開始觸發",
  RtsShindo1: "測站震度 2 以上",
  RtsShindo2: "測站震度 4 以上",
  RtsPga1: "測站加速度超過 8 gal",
  RtsPga2: "測站加速度超過 200 gal",
};

const onRts = rtsLog();
/** Whether a first live frame has come since the app started. */
let hadData = false;

const DESCRIBE: Describe = {
  MapLoad: () => log.info("地圖載入完成"),
  MainWindowHidden: (hidden) => log.info(hidden ? "主視窗隱藏" : "主視窗顯示"),
  InternetErrorChange: (down) => {
    // The flag is up from the start until the first frame: not a drop.
    if (!hadData) {
      if (down) log.info("等待第一筆即時資料");
      else log.info("收到第一筆即時資料");
      hadData = !down;
      return;
    }
    if (down) log.warn("超過時限沒有收到即時資料，顯示斷線警告");
    else log.info("即時資料恢復，斷線警告解除");
  },
  UpdateReady: (label) => log.info(`更新 ${label} 已下載，等重新啟動套用`),
  FocusLockChange: (locked) => log.debug(locked ? "使用者移動了地圖，自動聚焦暫停" : "自動聚焦恢復"),

  DataRts: (ans) => onRts(ans.data),
  DataModeReset: () => log.info("即時／重播切換，清除所有事件狀態"),

  EewRelease: (ans) => log.info(eew("地震預警 發布", ans)),
  EewUpdate: (ans) => log.info(eew("地震預警 更新", ans)),
  EewAlert: (ans) => log.warn(eew("地震預警 升級為警報", ans)),
  EewCancel: (ans) => log.warn(eew("地震預警 取消", ans)),
  EewEnd: (ans) => log.info(eew("地震預警 結束", ans)),
  EewNewAreaAlert: (ans) => log.warn(`${mode(ans)}預警新增警報區域：${ans.data.city_alert_list.join("、")}`),

  IntensityRelease: (ans) =>
    log.info(`${mode(ans)}震度速報 發布 ${ans.data.id}｜最大 ${shindo(ans.data.max)}｜${areas(ans.data.area)}`),
  IntensityUpdate: (ans) =>
    log.info(`${mode(ans)}震度速報 更新 ${ans.data.id}｜最大 ${shindo(ans.data.max)}｜${areas(ans.data.area)}`),
  IntensityEnd: (ans) => log.info(`${mode(ans)}震度速報 結束 ${(ans.data as { id?: number })?.id ?? ""}`),

  LpgmRelease: (ans) => {
    const max = Math.max(0, ...ans.data.list.map((l) => l.lpgm));
    log.info(`${mode(ans)}長週期地震動 ${ans.data.id}｜${ans.data.list.length} 站｜最大階級 ${max}`);
  },

  ReportRelease: (ans) => log.info(`${mode(ans)}${report(ans.data, ans.update)}`),
  ReportSpeechEnd: ({ id }) => log.debug(`報告 ${id} 的語音播報結束`),
  ReportListUpdate: () => log.debug(`報告列表更新，共 ${variable.data.report.length} 筆`),
  ReplayStateChange: ({ active, reportId }) =>
    log.info(active ? `重播開始${reportId ? `（報告 ${reportId}）` : "（檔案）"}` : "重播結束，回到即時"),

  RtsShindo0: () => log.info(`測站警報音：${RTS_SOUND.RtsShindo0}`),
  RtsShindo1: () => log.info(`測站警報音：${RTS_SOUND.RtsShindo1}`),
  RtsShindo2: () => log.warn(`測站警報音：${RTS_SOUND.RtsShindo2}`),
  RtsPga1: () => log.info(`測站警報音：${RTS_SOUND.RtsPga1}`),
  RtsPga2: () => log.warn(`測站警報音：${RTS_SOUND.RtsPga2}`),

  TsunamiRelease: (ans) => log.warn(`海嘯警報：${JSON.stringify(ans.data)}`),
};

/** 太頻繁、又沒有內容的 UI 訊號：資訊卡每 5 秒輪播一次。 */
const QUIET: ReadonlySet<keyof TremEvents> = new Set(["EewDisplayUpdate"]);

let started = false;

/** 在所有功能模組之前呼叫。 */
export function initEventLog(): void {
  if (started) return;
  started = true;
  for (const [type, describe] of Object.entries(DESCRIBE) as [keyof TremEvents, (p: unknown) => void][]) {
    events.on(type, (payload: unknown) => {
      try {
        describe(payload);
      } catch (e) {
        log.warn(`記錄 ${String(type)} 時出錯：`, e);
      }
    });
  }
  events.on("*", (type) => {
    if (!(type in DESCRIBE) && !QUIET.has(type)) log.debug(`事件 ${String(type)}`);
  });
}
