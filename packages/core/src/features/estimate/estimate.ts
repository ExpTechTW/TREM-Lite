// Ported from legacy/src/js/index/core/estimate.js

import { INTENSITY_LIST } from "@/lib/constants";
import { inTauri } from "@/lib/env";
import { events } from "@/lib/events";
import { createLogger, fmtDur } from "@/lib/logger";
import type { Ans, EewData } from "@/lib/types";
import { variable } from "@/lib/variable";
import { eewAreaIntensity, prepareIntensityModel, type EewArea } from "@/domain/eewMath";
import { search_loc_name, townColors } from "@/domain/utils";
import { paintTowns } from "@/lib/mapSource";

/** Predicted level for one town after merging the eq's reported area. */
interface MergedTown {
  I: number;
  dist: number;
}

/** Per-eew merged town map, plus the derived `max_i`. Stored in the cache. */
interface MergedArea {
  max_i: number;
  [code: string]: MergedTown | number;
}

const log = createLogger("estimate");

/** Cities we've already fired an `EewNewAreaAlert` for this episode. */
const alertedCities = new Set<string>();

async function updateEewArea(ans: Ans<EewData>): Promise<void> {
  // The ML model runs in Rust (src-tauri/src/math.rs, ml_intensity.rs).
  let area: EewArea["area"];
  const started = performance.now();
  const which = `預警 ${ans.data.id} 第 ${ans.data.serial} 報`;
  try {
    ({ area } = await eewAreaIntensity(
      ans.data.eq.lat,
      ans.data.eq.lon,
      ans.data.eq.depth,
      ans.data.eq.mag,
    ));
  } catch (e) {
    log.warn(`${which} 的預估震度算不出來，地圖不上色：`, e);
    return;
  }

  // Rust calculation can finish after an update, end, or replay transition.
  // Only the still-active matching serial is allowed to repaint the new mode.
  const stillActive = variable.data.eew.some(
    (item) => item.id === ans.data.id && item.serial === ans.data.serial && !item.EewEnd,
  );
  if (!stillActive) {
    log.debug(`${which} 的預估震度算完時，這一報已被更新或結束，丟棄`);
    return;
  }

  const mergedArea = mergeEqArea(area, ans.data.eq.area ?? {});
  const felt = Object.entries(area).filter(([, t]) => t.level > 0);
  const top = [...felt]
    .sort(([, a], [, b]) => b.level - a.level || a.dist - b.dist)
    .slice(0, 8)
    .map(([code, t]) => {
      const place = search_loc_name(Number(code));
      return `${place ? `${place.city}${place.town}` : code} ${INTENSITY_LIST[t.level] ?? t.level}`;
    })
    .join("、");
  log.info(
    `${which} 預估震度：${felt.length} 個鄉鎮有感，最大 ${INTENSITY_LIST[mergedArea.max_i] ?? mergedArea.max_i}｜${top || "無"}｜計算 ${fmtDur(performance.now() - started)}`,
  );
  variable.cache.eewIntensityArea[ans.data.id] = mergedArea;
  drawEewArea();
}

/** Repaint the "town" fill-color for the currently active eew intensity areas. */
export function drawEewArea(end = false): void {
  if (variable.cache.show_lpgm || variable.cache.show_intensity) {
    return;
  }

  const map = variable.map;
  if (!map) {
    return;
  }

  if (!Object.keys(variable.cache.eewIntensityArea).length) {
    paintTowns(map, null);
    return;
  }

  const eewArea = processIntensityAreas();
  const highIntensityCities = new Set<string>();

  Object.entries(eewArea).forEach(([code, intensity]) => {
    if (intensity >= 5) {
      const location = search_loc_name(parseInt(code));
      if (location) {
        highIntensityCities.add(location.city);
      }
    }
  });

  const newHighIntensityCities = new Set(
    [...highIntensityCities].filter((city) => !alertedCities.has(city)),
  );

  if (newHighIntensityCities.size > 0) {
    const payload = {
      info: {},
      data: {
        city_alert_list: Array.from(highIntensityCities),
        new_city_alert_list: Array.from(newHighIntensityCities),
      },
    };
    events.emit("EewNewAreaAlert", payload);
    newHighIntensityCities.forEach((city) => alertedCities.add(city));
  }

  // The last EEW ending returns the towns to the base colour.
  paintTowns(map, !variable.data.eew.length && end ? null : townColors(eewArea));

  if (end) {
    alertedCities.clear();
  }
}

function mergeEqArea(
  area: EewArea["area"],
  eqArea: Record<number, number[]>,
): MergedArea {
  const mergedArea: MergedArea = { max_i: 0 };

  Object.entries(area).forEach(([code, data]) => {
    mergedArea[code] = {
      I: data.level,
      dist: data.dist,
    };
  });

  Object.entries(eqArea).forEach(([intensity, codes]) => {
    const intensityFloat = parseFloat(intensity);
    codes.forEach((code) => {
      const town = mergedArea[code];
      if (town && typeof town !== "number" && town.I < intensityFloat) {
        town.I = intensityFloat;
      }
    });
  });

  let maxI = 0;
  Object.entries(mergedArea).forEach(([code, data]) => {
    if (code !== "max_i" && typeof data !== "number" && data.I > maxI) {
      maxI = data.I;
    }
  });
  mergedArea.max_i = maxI;

  return mergedArea;
}

/** Collapse every active eew's towns into a single code -> max intensity map. */
function processIntensityAreas(): Record<string, number> {
  const eewArea: Record<string, number> = {};

  Object.values(variable.cache.eewIntensityArea).forEach((intensity) => {
    Object.entries(intensity as MergedArea).forEach(([name, value]) => {
      if (name !== "max_i" && typeof value !== "number") {
        if (!eewArea[name] || eewArea[name] < value.I) {
          eewArea[name] = value.I;
        }
      }
    });
  });

  return eewArea;
}

/** Register the eew lifecycle subscriptions (was the require-time singleton). */
export function initEstimate(): void {
  // The web fetches and builds the model now, not when the first EEW comes.
  if (!inTauri) void prepareIntensityModel().catch(() => {});
  events.on("EewRelease", (ans) => void updateEewArea(ans));
  events.on("EewUpdate", (ans) => void updateEewArea(ans));
  events.on("EewEnd", (ans) => {
    delete variable.cache.eewIntensityArea[ans.data.id];
    drawEewArea(true);
  });
}
