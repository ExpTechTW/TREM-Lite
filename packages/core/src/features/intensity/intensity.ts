// Ported from legacy/src/js/index/core/intensity.js
import { type ExpressionSpecification, type GeoJSONSource } from "maplibre-gl";

import { events } from "@/lib/events";
import type { Ans } from "@/lib/types";
import { variable } from "@/lib/variable";
import { region } from "@/domain/region";
import { convertIntensityToAreaFormat, generateMapStyle, search_loc_name } from "@/domain/utils";
import { drawEewArea } from "@/features/estimate/estimate";
import { focus, isAutoFocusLocked } from "@/features/focus/focus";

/** Reported-intensity payload carried by IntensityRelease / IntensityUpdate. */
interface IntensityData {
  id: number;
  max: number;
  area: Record<number, number[]>;
}

/** One town marker fed to the `intensity-markers-geojson` source. */
interface IntensityMarkerFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { i: number };
}

type SetDataArg = Parameters<GeoJSONSource["setData"]>[0];

const EMPTY_COLLECTION = {
  type: "FeatureCollection",
  features: [],
} as unknown as SetDataArg;

/** Repaint the town/rts layers and drop reported-intensity square markers for 7.5s. */
function showIntensity(ans: Ans<IntensityData>): void {
  const map = variable.map;
  if (!map) {
    return;
  }

  (map.getSource("lpgm-markers-geojson") as GeoJSONSource | undefined)?.setData(EMPTY_COLLECTION);
  variable.cache.bounds.lpgm = [];
  variable.cache.show_lpgm = false;

  const dataList: IntensityMarkerFeature[] = [];
  const bounds: { lon: number; lat: number }[] = [];

  variable.cache.show_intensity = true;

  events.emit("DataRts", {
    info: { type: variable.play_mode },
    data: variable.data.rts,
  });

  variable.cache.intensity.time = ans.data.id;
  variable.cache.intensity.max = ans.data.max;

  events.emit("ReportListUpdate");

  const codeIntensity = convertIntensityToAreaFormat(
    ans.data.area as unknown as Record<string, number[]>,
  );

  const mapStyle = generateMapStyle(codeIntensity as Record<string, number>);
  map.setPaintProperty("town", "fill-color", mapStyle as unknown as ExpressionSpecification);
  map.setPaintProperty("rts-layer", "circle-opacity", 0.2);

  for (const code of Object.keys(codeIntensity)) {
    const loc = search_loc_name(Number(code));
    if (!loc) {
      continue;
    }
    const locInfo = region[loc.city][loc.town];
    bounds.push({ lon: locInfo.lon, lat: locInfo.lat });
    dataList.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [locInfo.lon, locInfo.lat] },
      properties: { i: codeIntensity[Number(code)] },
    });
  }

  variable.cache.bounds.intensity = bounds as never;

  (map.getSource("intensity-markers-geojson") as GeoJSONSource | undefined)?.setData({
    type: "FeatureCollection",
    features: dataList,
  } as unknown as SetDataArg);

  window.setTimeout(() => {
    if (!variable.cache.show_intensity) {
      return;
    }
    const activeMap = variable.map;
    if (!activeMap) {
      return;
    }
    variable.cache.show_intensity = false;
    events.emit("DataRts", {
      info: { type: variable.play_mode },
      data: variable.data.rts,
    });
    variable.cache.bounds.intensity = [];
    // 使用者未手動鎖定地圖時，重新聚焦到剩餘範圍（對應舊版 !getLock() → focus()）。
    if (!isAutoFocusLocked()) focus();
    activeMap.setPaintProperty("rts-layer", "circle-opacity", 1);
    (activeMap.getSource("intensity-markers-geojson") as GeoJSONSource | undefined)?.setData(
      EMPTY_COLLECTION,
    );
    drawEewArea();
  }, 7500);
}

/** Register the intensity map source/layer and its domain-event subscriptions. */
export function initIntensity(): void {
  events.on("DataModeReset", () => {
    variable.cache.show_intensity = false;
    variable.cache.bounds.intensity = [];
    const map = variable.map;
    (map?.getSource("intensity-markers-geojson") as GeoJSONSource | undefined)?.setData(
      EMPTY_COLLECTION,
    );
    if (map?.getLayer("rts-layer")) map.setPaintProperty("rts-layer", "circle-opacity", 1);
    drawEewArea();
  });

  events.on("MapLoad", () => {
    const map = variable.map;
    if (!map) {
      return;
    }

    map.addSource("intensity-markers-geojson", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

    map.addLayer({
      id: "intensity-markers",
      type: "symbol",
      source: "intensity-markers-geojson",
      layout: {
        "symbol-sort-key": [
          "match",
          ["get", "i"],
          9,
          -9,
          8,
          -8,
          7,
          -7,
          6,
          -6,
          5,
          -5,
          4,
          -4,
          3,
          -3,
          2,
          -2,
          -1,
        ] as ExpressionSpecification,
        "symbol-z-order": "source",
        "icon-image": [
          "match",
          ["get", "i"],
          1,
          "intensity-square-1",
          2,
          "intensity-square-2",
          3,
          "intensity-square-3",
          4,
          "intensity-square-4",
          5,
          "intensity-square-5",
          6,
          "intensity-square-6",
          7,
          "intensity-square-7",
          8,
          "intensity-square-8",
          9,
          "intensity-square-9",
          "intensity-square-0",
        ] as ExpressionSpecification,
        "icon-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          5,
          0.3,
          10,
          0.7,
        ] as ExpressionSpecification,
      },
    });
  });

  events.on("IntensityRelease", (ans) => showIntensity(ans));
  events.on("IntensityUpdate", (ans) => showIntensity(ans));

  events.on("IntensityEnd", () => {
    variable.cache.intensity.time = 0;
    variable.cache.intensity.max = 0;
    events.emit("ReportListUpdate");
    drawEewArea();
  });
}
