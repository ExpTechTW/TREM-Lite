/** Core domain types — loosely modeled from the ExpTech API payloads. */

export interface Eq {
  lat: number;
  lon: number;
  depth: number;
  mag: number;
  max: number;
  loc: string;
  time: number;
  area?: Record<number, number[]>;
}

export interface EewData {
  id: string;
  author: string;
  serial: number;
  status: number; // 0 warn, 1 alert, 3 cancel
  final?: number;
  eq: Eq;
  method?: string;
  time?: number;
  dist?: { p_dist: number; s_dist: number; s_t: number };
  // lifecycle flags set by DataManager
  EewEnd?: boolean;
  status3Time?: number;
}

export interface RtsStation {
  pga: number;
  i: number;
  I: number;
  alert: boolean;
}

export interface RtsData {
  station: Record<string, RtsStation>;
  box: Record<string, number>;
  int: { code: number; i: number }[];
  time: number;
}

export interface StationInfo {
  code: number;
  lon: number;
  lat: number;
}

export interface Station {
  info: StationInfo[];
  net?: string;
  work?: boolean;
}

export interface ReportListItem {
  id: string;
  lat: number;
  lon: number;
  depth: number;
  loc: string;
  mag: number;
  time: number;
  trem?: number;
  int?: number;
  /** content fingerprint from the report list — used to detect new reports */
  md5?: string;
  list?: Record<string, { int: number; town: Record<string, { int: number; lon: number; lat: number }> }>;
}

/** Envelope used across most events (mirrors the old `ans` shape). */
export interface Ans<T = unknown> {
  data: T;
  [k: string]: unknown;
}

/** Config shape mirrors default.yml. */
export interface TremConfig {
  ver: number;
  "location-code": number;
  "realtime-station-id": number;
  "alert-level": {
    "rts-intensity": number;
    "eew-intensity": number;
  };
  "check-box": Record<string, boolean>;
  apiProxyDomain: string;
}

/** mitt event map — event names preserved from the Electron app. */
export type TremEvents = {
  MapLoad: void;
  /** 自動聚焦鎖定狀態改變（使用者手動平移/縮放 → true；按定位鈕 → false）。 */
  FocusLockChange: boolean;
  /** 500ms 中央閃爍節拍（cross/box/nsspe 波前共用，取代各自的計時器）。 */
  Flash: boolean;
  /** EEW 資訊卡（ui.currentEew）內容更新，供 EewInfoBox 事件驅動刷新。 */
  EewDisplayUpdate: void;
  /** 斷線旗標（ui.internetError）改變，供 WarningBanners 事件驅動刷新。 */
  InternetErrorChange: boolean;

  DataRts: Ans<RtsData | null>;
  /** Clears module-local RTS/UI history at a live/replay mode boundary. */
  DataModeReset: void;
  DataEew: Ans<EewData>;
  DataIntensity: Ans<unknown>;
  DataLpgm: Ans<unknown>;

  EewRelease: Ans<EewData>;
  EewUpdate: Ans<EewData>;
  EewEnd: Ans<EewData>;
  EewAlert: Ans<EewData>;
  EewCancel: Ans<EewData>;
  EewNewAreaAlert: Ans<{ city_alert_list: string[] }>;

  IntensityRelease: Ans<{ id: number; max: number; area: Record<number, number[]> }>;
  IntensityUpdate: Ans<{ id: number; max: number; area: Record<number, number[]> }>;
  IntensityEnd: Ans<unknown>;

  LpgmRelease: Ans<{ id: number; time: number; list: { id: number; lpgm: number }[] }>;
  LpgmEnd: Ans<unknown>;

  ReportRelease: Ans<ReportListItem>;
  /** UI 刷新訊號：報告列表（variable.data.report）內容有更新時發出。 */
  ReportListUpdate: void;
  /** 重播模式切換；reportId 只在由報告列啟動的 HTTP 重播存在。 */
  ReplayStateChange: { active: boolean; reportId?: string };

  RtsPga1: void;
  RtsPga2: void;
  RtsShindo0: void;
  RtsShindo1: void;
  RtsShindo2: void;

  TsunamiRelease: Ans<unknown>;
};
