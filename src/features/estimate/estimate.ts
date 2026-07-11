// Ported from legacy/src/js/index/core/estimate.js
import type { ExpressionSpecification } from "maplibre-gl";

import { COLOR, SHOW_TREM_EEW } from "@/lib/constants";
import { events } from "@/lib/events";
import type { Ans, EewData } from "@/lib/types";
import { variable } from "@/lib/variable";
import { eewAreaPga, type EewArea } from "@/domain/eewMath";
import { generateMapStyle, intensity_float_to_int, search_loc_name } from "@/domain/utils";

/** Predicted intensity for one town after merging the eq's reported area. */
interface MergedTown {
  I: number;
  i: number;
  dist: number;
}

/** Per-eew merged town map, plus the derived `max_i`. Stored in the cache. */
interface MergedArea {
  max_i: number;
  [code: string]: MergedTown | number;
}

/** Cities we've already fired an `EewNewAreaAlert` for this episode. */
const alertedCities = new Set<string>();

async function updateEewArea(ans: Ans<EewData>): Promise<void> {
  if (!SHOW_TREM_EEW && ans.data.author === "trem") {
    return;
  }

  // Heavy per-town attenuation loop runs in Rust (src-tauri/src/math.rs).
  const { area } = await eewAreaPga(
    ans.data.eq.lat,
    ans.data.eq.lon,
    ans.data.eq.depth,
    ans.data.eq.mag,
  );

  const mergedArea = mergeEqArea(area, ans.data.eq.area ?? {});
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
    map.setPaintProperty("town", "fill-color", COLOR.MAP.TW_TOWN_FILL);
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

  const mapStyle = generateMapStyle(eewArea, !variable.data.eew.length && end);
  map.setPaintProperty("town", "fill-color", mapStyle as unknown as ExpressionSpecification);

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
      I: intensity_float_to_int(data.i),
      i: data.i,
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
  events.on("EewRelease", (ans) => void updateEewArea(ans));
  events.on("EewUpdate", (ans) => void updateEewArea(ans));
  events.on("EewEnd", (ans) => {
    delete variable.cache.eewIntensityArea[ans.data.id];
    drawEewArea(true);
  });
}
