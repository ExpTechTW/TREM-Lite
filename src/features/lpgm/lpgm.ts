// Ported from legacy/src/js/index/core/lpgm.js
import type {
  ExpressionSpecification,
  GeoJSONSource,
} from "maplibre-gl";

import { events } from "@/lib/events";
import type { Ans, RtsData } from "@/lib/types";
import { variable } from "@/lib/variable";
import { generateMapStyle } from "@/domain/utils";
import { drawEewArea } from "@/features/estimate/estimate";
import { focus, isAutoFocusLocked } from "@/features/focus/focus";

/** One entry of an LPGM (long-period ground motion) release payload. */
interface LpgmListItem {
  id: number;
  lpgm: number;
}

/** Feature pushed into the "lpgm-markers-geojson" source. */
interface LpgmFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { i: number };
}

interface LpgmFeatureCollection {
  type: "FeatureCollection";
  features: LpgmFeature[];
}

const EMPTY_COLLECTION: LpgmFeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

/** How long the LPGM overlay stays visible before reverting (ms). */
const LPGM_DISPLAY_MS = 15000;

/** Retrieve a GeoJSON source by id if the map is ready. */
function getSource(id: string): GeoJSONSource | null {
  const map = variable.map;
  if (!map) {
    return null;
  }
  return (map.getSource(id) as GeoJSONSource | undefined) ?? null;
}

/** Re-broadcast the current RTS data so overlays repaint. */
function emitDataRts(): void {
  events.emit("DataRts", {
    info: { type: variable.play_mode },
    data: variable.data.rts,
  } satisfies Ans<RtsData | null>);
}

function show_lpgm(ans: Ans<{ id: number; time: number; list: LpgmListItem[] }>): void {
  const map = variable.map;
  if (!map) {
    return;
  }

  getSource("intensity-markers-geojson")?.setData(EMPTY_COLLECTION);
  variable.cache.bounds.intensity = [];
  variable.cache.show_intensity = false;

  const data_list: LpgmFeature[] = [];
  const bounds: { lon: number; lat: number }[] = [];
  const code_intensity: Record<number, number> = {};

  variable.cache.show_lpgm = true;

  emitDataRts();

  // TODO(react-overlay): render the max LPGM level and the affected city list
  // (the legacy module computed these but had no place to display them).

  for (const station of ans.data.list) {
    if (!station.lpgm) {
      continue;
    }

    const station_info = variable.station?.[station.id];
    if (!station_info) {
      continue;
    }
    const station_location = station_info.info.at(-1);
    if (!station_location) {
      continue;
    }

    if (!code_intensity[station_location.code]) {
      code_intensity[station_location.code] = 0;
    }

    if (code_intensity[station_location.code] < station.lpgm) {
      code_intensity[station_location.code] = station.lpgm;
    }

    bounds.push({ lon: station_location.lon, lat: station_location.lat });
    data_list.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [station_location.lon, station_location.lat],
      },
      properties: { i: station.lpgm },
    });
  }

  const mapStyle = generateMapStyle(code_intensity, false, true);
  map.setPaintProperty(
    "town",
    "fill-color",
    mapStyle as unknown as ExpressionSpecification,
  );
  map.setPaintProperty("rts-layer", "circle-opacity", 0.2);

  variable.cache.bounds.lpgm = bounds as never;

  focus();

  getSource("lpgm-markers-geojson")?.setData({
    type: "FeatureCollection",
    features: data_list,
  });

  setTimeout(() => {
    if (!variable.cache.show_lpgm) {
      return;
    }
    variable.cache.show_lpgm = false;
    emitDataRts();
    variable.cache.bounds.lpgm = [];
    if (!isAutoFocusLocked()) {
      focus();
    }
    variable.map?.setPaintProperty("rts-layer", "circle-opacity", 1);
    getSource("lpgm-markers-geojson")?.setData(EMPTY_COLLECTION);
    drawEewArea();
  }, LPGM_DISPLAY_MS);
}

/** Register the LPGM overlay source/layer and release subscription. */
export function initLpgm(): void {
  events.on("MapLoad", () => {
    const map = variable.map;
    if (!map) {
      return;
    }

    map.addSource("lpgm-markers-geojson", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

    const symbolSortKey: ExpressionSpecification = [
      "match",
      ["get", "i"],
      4, -4,
      3, -3,
      2, -2,
      -1,
    ];

    const iconImage: ExpressionSpecification = [
      "match",
      ["get", "i"],
      2, "lpgm-2",
      3, "lpgm-3",
      4, "lpgm-4",
      "lpgm-1",
    ];

    const iconSize: ExpressionSpecification = [
      "interpolate",
      ["linear"],
      ["zoom"],
      5, 0.3,
      10, 0.7,
    ];

    map.addLayer({
      id: "lpgm-markers",
      type: "symbol",
      source: "lpgm-markers-geojson",
      layout: {
        "symbol-sort-key": symbolSortKey,
        "symbol-z-order": "source",
        "icon-image": iconImage,
        "icon-size": iconSize,
      },
    });
  });

  events.on("LpgmRelease", (ans) => show_lpgm(ans));
}
