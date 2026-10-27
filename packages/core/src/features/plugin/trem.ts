/**
 * The `TREM` global a plugin receives as `ctx.TREM`.
 *
 * V3 plugins were written against the object `legacy/src/js/index/constant.js`
 * published: `TREM.constant` (colours, limits, URLs), `TREM.variable` (live app
 * state) and `TREM.class` (the app's manager classes). This module rebuilds it
 * from V4's equivalents.
 *
 * Two rules decide what is here. `variable` is handed over **by reference** —
 * a plugin that writes `TREM.variable.cache.show_intensity` is mutating the
 * app's own state, which is what V3 plugins do — and anything V4 genuinely does
 * not have is left out rather than faked, so a plugin that depends on it fails
 * loudly at the point of use instead of silently doing nothing.
 */
import * as audioClient from "@/lib/audioClient";
import {
  COLOR,
  EEW_AUTHOR,
  HTTP_TIMEOUT,
  INTENSITY_LIST,
  LAST_DATA_TIMEOUT_ERROR,
  MAP,
  REPORT_LIMIT,
  SHOW_REPORT,
} from "@/lib/constants";
import { HOST } from "@/lib/endpoints";
import { events } from "@/lib/events";
import { variable, type TremVariable } from "@/lib/variable";

/** `variable` as a V3 plugin sees it: the app state plus the event bus. */
export type PluginVariable = TremVariable & { events: typeof events };

export interface TremGlobal {
  constant: {
    COLOR: typeof COLOR;
    HTTP_TIMEOUT: typeof HTTP_TIMEOUT;
    LAST_DATA_TIMEOUT_ERROR: number;
    EEW_AUTHOR: string[];
    REPORT_LIMIT: number;
    MAP: typeof MAP;
    SHOW_REPORT: boolean;
    INTENSITY_LIST: string[];
    URL: { API: string; LB: string; REPLAY: string };
  };
  variable: PluginVariable;
  /**
   * Only the managers with a V4 counterpart are present. DataManager,
   * ReportManager, FocusManager, EewAreaManager, BoxManager, ReplayControler
   * and WindowControler are gone — V4 splits that work across `features/` and
   * Rust — so they are `undefined` here on purpose.
   */
  class: { AudioManager: typeof audioClient };
}

/** Built once: a plugin compares `ctx.TREM.variable` by identity. */
let cached: TremGlobal | null = null;

export function tremGlobal(): TremGlobal {
  if (cached) return cached;

  const live = variable as PluginVariable;
  // V3 kept the bus at `TREM.variable.events`; plugins call
  // `TREM.variable.events.on('DataRts', …)`. Assigning it onto the singleton
  // keeps that reachable and leaves the object identity intact.
  live.events = events;

  cached = {
    constant: {
      COLOR,
      HTTP_TIMEOUT,
      LAST_DATA_TIMEOUT_ERROR,
      EEW_AUTHOR: [...EEW_AUTHOR],
      REPORT_LIMIT,
      MAP,
      SHOW_REPORT,
      INTENSITY_LIST: [...INTENSITY_LIST],
      URL: {
        API: `https://${HOST.lbApi}`,
        LB: `https://${HOST.lbStatic}`,
        REPLAY: `https://${HOST.coreApi}`,
      },
    },
    variable: live,
    class: { AudioManager: audioClient },
  };
  return cached;
}
