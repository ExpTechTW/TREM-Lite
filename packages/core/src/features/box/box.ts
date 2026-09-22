// Ported from legacy/src/js/index/core/box.js
import type { ExpressionSpecification } from "maplibre-gl";

import boxBinUrl from "@/data/box.bin?url";
import { COLOR, SHOW_TREM_EEW } from "@/lib/constants";
import { events } from "@/lib/events";
import { type BoxFeature as BinBoxFeature, decodeBox } from "@/lib/bindata";
import type { EewData } from "@/lib/types";
import { variable } from "@/lib/variable";
import { distance } from "@/domain/utils";
import { http } from "@/lib/http";
import { setFeatures } from "@/lib/mapSource";

// Alert-box polygons, loaded async from the compact binary (out of the JS
// bundle). Only used during an active alert, long after startup.
let boxFeaturesData: BinBoxFeature[] = [];
void http
  .asset(boxBinUrl)
  .then((buf) => {
    boxFeaturesData = decodeBox(buf).features;
  })
  .catch(() => {});

/** Output feature pushed into the "box-geojson" source. */
interface BoxFeature {
  type: "Feature";
  geometry: { type: "Polygon"; coordinates: number[][][] };
  properties: { i: number };
}


let box_alert = false;


/**
 * True when the EEW S-wave has fully engulfed a box (all four corners inside
 * the S-wave radius), meaning the box should be skipped.
 */
function checkBoxSkip(eew: EewData, area: BinBoxFeature): boolean {
  if (!eew.dist) {
    return false;
  }
  // All four or nothing, so the first corner outside the wave settles it —
  // which for almost every box is the first corner, not the fourth.
  const coordinates = area.geometry.coordinates[0];
  for (let i = 0; i < 4; i++) {
    const dist = distance(eew.eq.lat, eew.eq.lon, coordinates[i][1], coordinates[i][0]);
    if (!(eew.dist.s_dist > dist)) {
      return false;
    }
  }
  return true;
}

/** Rebuild the box overlay from the latest RTS box intensities. */
export function refresh_box(show: boolean): void {
  // One write per tick, of the state the tick ends in. This used to empty the
  // source first and then fill it again on every visible tick — two tile
  // reloads every 500 ms, where the first never reached the screen.
  const map = variable.map;
  const rts = variable.data.rts;
  if (!rts?.box || !Object.keys(rts.box).length) {
    if (box_alert) {
      box_alert = false;
      if (map) setFeatures(map, "box-geojson", []);
    }
    return;
  }

  const trem_alert = variable.data.eew.some((eew) => eew.author == "trem");
  if (!SHOW_TREM_EEW && trem_alert) {
    box_alert = false;
    if (map) setFeatures(map, "box-geojson", []);
    return;
  }

  const boxFeatures: BoxFeature[] = [];
  if (show) {
    for (const area of boxFeaturesData) {
      const id = area.properties.ID;
      const boxIntensity = rts.box[id];
      if (boxIntensity == undefined) {
        continue;
      }

      let shouldSkip = false;
      for (const eew of variable.data.eew) {
        if (!eew.dist) {
          continue;
        }
        if (checkBoxSkip(eew, area)) {
          shouldSkip = true;
          break;
        }
      }
      if (shouldSkip) {
        continue;
      }

      boxFeatures.push({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [area.geometry.coordinates[0]],
        },
        properties: {
          i: boxIntensity,
        },
      });
    }
  }

  boxFeatures.sort((a, b) => (a.properties?.i || 0) - (b.properties?.i || 0));
  box_alert = true;
  if (map) setFeatures(map, "box-geojson", boxFeatures as unknown as GeoJSON.Feature[]);
}

/** Register the box overlay source/layer once the map has loaded. */
export function initBox(): void {
  events.on("MapLoad", () => {
    const map = variable.map;
    if (!map) {
      return;
    }

    map.addSource("box-geojson", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: [],
      },
    });

    const lineColor: ExpressionSpecification = [
      "match",
      ["get", "i"],
      9, COLOR.BOX[2],
      8, COLOR.BOX[2],
      7, COLOR.BOX[2],
      6, COLOR.BOX[2],
      5, COLOR.BOX[2],
      4, COLOR.BOX[2],
      3, COLOR.BOX[1],
      2, COLOR.BOX[1],
      1, COLOR.BOX[0],
      COLOR.BOX[0],
    ];

    map.addLayer({
      id: "box-geojson",
      type: "line",
      source: "box-geojson",
      paint: {
        "line-width": 2,
        "line-color": lineColor,
      },
    });
  });
}
