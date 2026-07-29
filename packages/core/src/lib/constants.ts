/**
 * Static app constants — ported from legacy/src/js/index/constant.js `TREM.constant`.
 * Colors are the single source of truth shared with styles/globals.css tokens.
 */

export const COLOR = {
  MAP: {
    BACKGROUND: "#1f2025",
    TW_COUNTY_FILL: "#3F4045",
    TW_TOWN_FILL: "#3F4045",
    TW_COUNTY_OUTLINE: "#a9b4bc",
    GLOBAL_FILL: "#3F4045",
  },
  RTS: {
    intensity_3: "#0005d0",
    intensity_2: "#004bf8",
    intensity_1: "#009EF8",
    intensity0: "#79E5FD",
    intensity1: "#49E9AD",
    intensity2: "#44fa34",
    intensity3: "#beff0c",
    intensity4: "#fff000",
    intensity5: "#ff9300",
    intensity6: "#fc5235",
    intensity7: "#b720e9",
  } as Record<string, string>,
  INTENSITY: {
    0: "#202020",
    1: "#003264",
    2: "#0064c8",
    3: "#1e9632",
    4: "#ffc800",
    5: "#ff9600",
    6: "#ff6400",
    7: "#ff0000",
    8: "#c00000",
    9: "#9600c8",
  } as Record<number, string>,
  INTENSITY_TEXT: {
    0: "#ffffff",
    1: "#ffffff",
    2: "#ffffff",
    3: "#ffffff",
    4: "#000000",
    5: "#000000",
    6: "#000000",
    7: "#ffffff",
    8: "#ffffff",
    9: "#ffffff",
  } as Record<number, string>,
  LPGM: {
    1: "#0040ff",
    2: "#ffe600",
    3: "#ff2800",
    4: "#a50021",
  } as Record<number, string>,
  LPGM_TEXT: {
    1: "#ffffff",
    2: "#000000",
    3: "#ffffff",
    4: "#ffffff",
  } as Record<number, string>,
  EEW: {
    S: {
      WARN: "#ffaa00",
      ALERT: "#ff0000",
      CANCEL: "#000",
      RTS: "#0005d0",
    },
    TRIGGER: {
      LOW: "#1e9632",
      MIDDLE: "#ffc800",
      HIGH: "#c00000",
    },
    P: "#00CACA",
  },
  TREM: {
    S: "#beff0c",
    P: "#beff0c",
  },
  BOX: {
    0: "#00DB00",
    1: "#EAC100",
    2: "#FF0000",
  } as Record<number, string>,
} as const;

export const SHOW_TREM_EEW = false;

export const URL = {
  API: ["api-1.exptech.dev", "api-2.exptech.dev"],
} as const;

/** Logical clip names — playback happens in Rust (see lib/audioClient.ts). */
export const AUDIO = {
  ALERT: "ALERT",
  EEW: "EEW",
  INTENSITY: "INTENSITY",
  PGA1: "PGA1",
  PGA2: "PGA2",
  REPORT: "REPORT",
  SHINDO0: "SHINDO0",
  SHINDO1: "SHINDO1",
  SHINDO2: "SHINDO2",
  TSUNAMI: "TSUNAMI",
  UPDATE: "UPDATE",
  CANCEL: "CANCEL",
} as const;

export const HTTP_TIMEOUT = {
  LOOP: 1000,
  RESOURCE: 3500,
  RTS: 1000,
  EEW: 1000,
  REPORT: 5000,
  INTENSITY: 1000,
  LPGM: 1000,
  NTP: 1000,
} as const;

export const LAST_DATA_TIMEOUT_ERROR = 3000;
export const EEW_AUTHOR = ["trem", "cwa"] as const;
export const REPORT_LIMIT = 150;

export const MAP = {
  BOUNDS: [
    [118.0, 21.2],
    [124.0, 25.8],
  ] as [[number, number], [number, number]],
  OPTIONS: { padding: 20, duration: 0 },
} as const;

export const SHOW_REPORT = true;

/** CWA intensity labels 0..9. */
export const INTENSITY_LIST = ["0", "1", "2", "3", "4", "5⁻", "5⁺", "6⁻", "6⁺", "7"];

export const DEFAULT_API_PROXY_DOMAIN = "api.lb.exptech.dev";
