// Ported from legacy/src/js/index/core/cross.js
import { type ExpressionSpecification, type GeoJSONSource } from "maplibre-gl";

import { COLOR, SHOW_TREM_EEW } from "@/lib/constants";
import { events } from "@/lib/events";
import { variable } from "@/lib/variable";

/** Whether the cross source currently holds (stale) features that need clearing. */
let clean = false;

interface CrossFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    no: number;
    markerType: "cross" | "dot";
    maxIntensity: number;
    fillColor: string;
    strokeColor: string;
    opacity: number;
  };
}

type SetDataArg = Parameters<GeoJSONSource["setData"]>[0];

/** EEW record shape, derived from the shared `variable` state contract. */
type EewItem = (typeof variable.data.eew)[number];

/** Register the MapLoad subscription that builds the `cross-geojson` source and `cross` layer. */
export function initCross(): void {
  events.on("MapLoad", () => {
    const map = variable.map;
    if (!map) return;

    map.addSource("cross-geojson", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

    map.addLayer({
      id: "cross",
      type: "symbol",
      source: "cross-geojson",
      layout: {
        "symbol-sort-key": ["get", "no"] as ExpressionSpecification,
        "symbol-z-order": "source",
        "icon-image": [
          "case",
          ["==", ["get", "markerType"], "dot"],
          "dot",
          [
            "match",
            ["get", "no"],
            1,
            "cross1",
            2,
            "cross2",
            3,
            "cross3",
            4,
            "cross4",
            "cross",
          ],
        ] as ExpressionSpecification,
        "icon-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          5,
          0.02,
          10,
          0.1,
        ] as ExpressionSpecification,
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      paint: {
        "icon-opacity": ["get", "opacity"] as ExpressionSpecification,
      },
    });
  });
}

/** Rebuild the EEW cross/dot markers. Imported by the eew & loop modules. */
export function refresh_cross(show: boolean): void {
  const map = variable.map;
  if (!map) return;

  const markerFeatures: CrossFeature[] = [];
  const eew_list: EewItem[] = [];

  if (!variable.data.eew?.length) {
    if (clean) {
      (map.getSource("cross-geojson") as GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        features: [],
      } as unknown as SetDataArg);
      clean = false;
    }
    return;
  }

  clean = true;

  for (const eew of variable.data.eew) {
    if (!SHOW_TREM_EEW && eew.author == "trem") {
      continue;
    }
    const sWaveSource = map.getSource(`${eew.id}-s-wave`);
    const pWaveSource = map.getSource(`${eew.id}-p-wave`);
    if (eew.status == 3 || (sWaveSource && pWaveSource)) {
      eew_list.push(eew);
    }
  }

  for (const eew of eew_list) {
    const sWaveSource = map.getSource(`${eew.id}-s-wave`);
    const pWaveSource = map.getSource(`${eew.id}-p-wave`);

    if (eew.status == 3 || (sWaveSource && pWaveSource)) {
      const existingIndex = eew_list.findIndex((item) => item.id === eew.id);
      let no = existingIndex;
      if (eew_list.length > 1) {
        no++;
      }

      if (show || eew.status == 3) {
        const opacity = eew.status == 3 ? 0.6 : 1;
        markerFeatures.push({
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [eew.eq.lon, eew.eq.lat],
          },
          properties: {
            no: no < 5 ? no : 0,
            markerType: eew.method == "eew" ? "cross" : "dot",
            maxIntensity: eew.eq.max,
            fillColor: COLOR.INTENSITY[eew.eq.max],
            strokeColor: COLOR.INTENSITY_TEXT[eew.eq.max],
            opacity: opacity,
          },
        });
      }
    }
  }

  (map.getSource("cross-geojson") as GeoJSONSource | undefined)?.setData({
    type: "FeatureCollection",
    features: markerFeatures,
  } as unknown as SetDataArg);

  if (!map.getLayer("dots")) {
    map.addLayer({
      id: "dots",
      type: "circle",
      source: "cross-geojson",
      filter: ["==", ["get", "markerType"], "dot"] as ExpressionSpecification,
      paint: {
        "circle-radius": 10,
        "circle-color": ["get", "fillColor"] as ExpressionSpecification,
        "circle-stroke-width": 4,
        "circle-stroke-color": ["get", "strokeColor"] as ExpressionSpecification,
        "circle-opacity": ["get", "opacity"] as ExpressionSpecification,
        "circle-stroke-opacity": ["get", "opacity"] as ExpressionSpecification,
      },
    });
  }

  // Every moveLayer forces a style update and a full label placement, and this
  // ran every 500 ms whether or not the order had changed. Moving them only
  // when they are not already the top two ends in the same order.
  const order = map.getLayersOrder();
  if (order.at(-2) !== "cross" || order.at(-1) !== "dots") {
    map.moveLayer("cross");
    map.moveLayer("dots");
  }
}
