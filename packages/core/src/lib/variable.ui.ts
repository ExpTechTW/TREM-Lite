/**
 * Optional shared UI-state slice for values computed by the imperative feature
 * modules that React overlays want to render (avoids duplicating heavy compute).
 * Feature modules may write here; overlays read on the relevant event.
 */
/** The single EEW the rotation logic currently wants the info box to display. */
export interface EewDisplay {
  id: string;
  /** CSS state class: eew-cancel | eew-alert | eew-rts | eew-warn. */
  statusClass: string;
  serial: number;
  final: boolean;
  /** e.g. "CWA 1/2" or just "CWA" when there is a single EEW. */
  unitText: string;
  loc: string;
  depth: number;
  mag: number;
  max: number;
  /** NSSPE placeholder (mag == 1) footer flag. */
  nsspe: boolean;
  /** Origin time (ms) — React formats it. */
  time: number;
}

export interface RtsTriggerLocation {
  i: number;
  name: string;
}

export interface RtsTriggerDisplay {
  max: number;
  locations: RtsTriggerLocation[];
}

export interface TremUi {
  maxIntensity: { i: number; label: string };
  maxPga: number;
  currentStation: { loc: string; i: number; pga: number } | null;
  rtsInfo: { level: number; trigger: number };
  unstable: boolean;
  internetError: boolean;
  /** Currently-shown EEW (null when the box is hidden / no EEW active). */
  currentEew: EewDisplay | null;
  /** RTS trigger summary shown in the EEW box when no authored EEW is active. */
  currentTrigger: RtsTriggerDisplay | null;
}

export const ui: TremUi = {
  maxIntensity: { i: 0, label: "0" },
  maxPga: 0,
  currentStation: null,
  rtsInfo: { level: 0, trigger: 0 },
  unstable: false,
  internetError: false,
  currentEew: null,
  currentTrigger: null,
};
