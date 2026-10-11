/**
 * Mutable app-state singleton — ported from `TREM.variable` in constant.js.
 *
 * The imperative data/feature layer (DataManager, rts/eew/… map drivers) reads
 * and writes this object directly, exactly like the Electron app did. React
 * overlays stay reactive by subscribing to the `events` bus (see hooks/useTremEvent)
 * and pulling from here, plus the mutable `ui` object (variable.ui.ts) for shared
 * UI values.
 */
import type { Map as MlMap } from "maplibre-gl";

import type { EewData, RtsData, Station } from "./types";
import type { RtsTriggerLocation } from "./variable.ui";

export interface TremVariable {
  map: MlMap | null;
  data: {
    rts: RtsData | null;
    intensity: unknown[];
    report: unknown[];
    eew: EewData[];
    lpgm: unknown[];
  };
  /** 0 realtime (SSE) | 2 replay (HTTP) | 3 replay (file). 1, legacy's WebSocket mode, is never set. */
  play_mode: number;
  replay: { start_time: number; local_time: number; dev: boolean };
  /** Hex-id stations of the rts.v1 feed (see features/data/resource.ts). */
  station: Record<string, Station> | null;
  /** Decimal-id stations of the older network, still named by lpgm reports. */
  legacyStation: Record<string, Station> | null;
  cache: {
    rts_alert: boolean;
    unstable: number;
    show_eew_box: boolean;
    rts_trigger: { max: number; loc: RtsTriggerLocation[] };
    last_report: unknown;
    eewIntensityArea: Record<string, unknown>;
    show_intensity: boolean;
    show_lpgm: boolean;
    eew_last: Record<string, unknown>;
    intensity_last: Record<string, unknown>;
    /** The clock's calibration: server − local, ms (lib/ntp.ts). */
    time: { offset: number };
    intensity: { time: number; max: number };
    last_data_time: number;
    last_rts_alert: number;
    bounds: {
      rts: number[];
      intensity: number[];
      report: number[];
      lpgm: number[];
    };
    audio: {
      shindo: number;
      pga: number;
      status: { shindo: number; pga: number };
      count: { pga_1: number; pga_2: number; shindo_1: number; shindo_2: number };
    };
  };
}

export const variable: TremVariable = {
  map: null,
  data: {
    rts: null,
    intensity: [],
    report: [],
    eew: [],
    lpgm: [],
  },
  play_mode: 0,
  replay: { start_time: 0, local_time: 0, dev: false },
  station: null,
  legacyStation: null,
  cache: {
    rts_alert: false,
    unstable: 0,
    show_eew_box: false,
    rts_trigger: { max: 0, loc: [] },
    last_report: null,
    eewIntensityArea: {},
    show_intensity: false,
    show_lpgm: false,
    eew_last: {},
    intensity_last: {},
    time: { offset: 0 },
    intensity: { time: 0, max: 0 },
    last_data_time: 0,
    last_rts_alert: 0,
    bounds: { rts: [], intensity: [], report: [], lpgm: [] },
    audio: {
      shindo: -1,
      pga: -1,
      status: { shindo: 0, pga: 0 },
      count: { pga_1: 0, pga_2: 0, shindo_1: 0, shindo_2: 0 },
    },
  },
};

/**
 * An earthquake still holds the map: an EEW, the 15s after an RTS alert,
 * an intensity or long-period overlay, or a replay.
 *
 * A missing RTS time is not that 15s tail — there is no alert frame to
 * measure from. Callers that already have this frame's `rts.time` keep using
 * that value themselves; this reads whatever the app last stored.
 */
export function eventHoldsMap(): boolean {
  if (variable.cache.show_lpgm || variable.cache.show_intensity) return true;
  if (variable.data.eew.length > 0) return true;
  if (variable.play_mode == 2 || variable.play_mode == 3) return true;
  const time = variable.data.rts?.time;
  return time != null && time - variable.cache.last_rts_alert < 15000;
}
