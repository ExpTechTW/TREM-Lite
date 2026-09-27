// Ported from legacy/src/js/index/core/box.js
//
// What flashes on the map while stations are triggered — that is, while there
// are boxes to show. Two ways, by whether the RTS feed lists an earthquake
// (rts.v1 `eq`, see data/rtsV1.ts):
//
// * none listed — the detection boxes the triggered stations stand in;
// * any listed  — no boxes at all. Each listed earthquake's S wavefront and a
//   small dot on its epicentre flash in their place, fainter than an EEW's
//   rings, on the same beat and in the same colours as the boxes. An
//   earthquake with an EEW within 50 km is left out: that EEW's own rings
//   already show it.
//
// The wavefronts only stand in for the boxes: they flash while there are
// boxes to replace, and stop when the boxes would — even though the feed keeps
// an earthquake listed for 240 s after its origin.
import type { ExpressionSpecification } from "maplibre-gl";

import { COLOR } from "@/lib/constants";
import { events } from "@/lib/events";
import type { BoxFeature as BinBoxFeature } from "@/lib/bindata";
import type { EewData, RtsData, RtsEq } from "@/lib/types";
import { variable } from "@/lib/variable";
import { distance, intensity_float_to_int } from "@/domain/utils";
import { replaceFeatures, setFeatures } from "@/lib/mapSource";
import { now } from "@/lib/ntp";
import { createCircleFeature, waveCalculator } from "@/features/eew/waves";

import { getBoxes } from "./polygons";

/** Output feature pushed into the "box-geojson" source. */
interface BoxFeature {
  type: "Feature";
  geometry: { type: "Polygon"; coordinates: number[][][] };
  properties: { i: number };
}

/** An EEW this close (km, horizontal) to a listed earthquake is taken to be that earthquake. */
const EEW_NEAR_KM = 50;

let box_alert = false;
let eq_alert = false;

/** Box and wavefront colour by intensity level: green up to 1, yellow 2–3, red from 4. */
const LEVEL_COLOR: ExpressionSpecification = [
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

function clearBoxes(): void {
  if (!box_alert) return;
  box_alert = false;
  if (variable.map) setFeatures(variable.map, "box-geojson", []);
}

function clearEqWaves(): void {
  if (!eq_alert) return;
  eq_alert = false;
  if (variable.map) setFeatures(variable.map, "eq-waves", []);
}

/** Whether an EEW lies within EEW_NEAR_KM of the point. */
function nearEew(lat: number, lon: number): boolean {
  return variable.data.eew.some((eew) => distance(lat, lon, eew.eq.lat, eew.eq.lon) <= EEW_NEAR_KM);
}

/**
 * Each earthquake's colour level: the highest intensity level among the
 * triggered stations nearer to it than to any other listed earthquake — for
 * the usual single earthquake, simply the highest triggered level.
 */
function eqLevels(rts: RtsData, eqs: RtsEq[]): number[] {
  const levels = eqs.map(() => 0);
  for (const [id, s] of Object.entries(rts.station)) {
    if (!s.alert) continue;
    let nearest = 0;
    if (eqs.length > 1) {
      const at = variable.station?.[id]?.info.at(-1);
      if (!at) continue;
      let best = Infinity;
      eqs.forEach(([lat, lon], n) => {
        const km = distance(lat, lon, at.lat, at.lon);
        if (km < best) {
          best = km;
          nearest = n;
        }
      });
    }
    levels[nearest] = Math.max(levels[nearest], intensity_float_to_int(s.i));
  }
  return levels;
}

/** Flash the listed earthquakes' S wavefronts and epicentres. */
function refreshEqWaves(rts: RtsData, eqs: RtsEq[], show: boolean): void {
  const map = variable.map;
  const calculator = waveCalculator();
  const rings: GeoJSON.Feature[] = [];
  if (show && calculator) {
    const levels = eqLevels(rts, eqs);
    const time = now();
    eqs.forEach(([lat, lon, depth, origin], n) => {
      if (nearEew(lat, lon)) return;
      const properties = { i: levels[n] };
      rings.push({ type: "Feature", properties, geometry: { type: "Point", coordinates: [lon, lat] } });
      const radius = calculator.psWaveDist(depth, origin * 1000, time).s_dist;
      // 0 until the S wave has left the hypocentre and reached the surface.
      if (!(radius > 0)) return;
      const ring = createCircleFeature([lon, lat], radius);
      ring.properties = properties;
      rings.push(ring);
    });
  }
  if (!map) return;
  if (rings.length) {
    // The rings grow on every tick, so there is nothing to compare against.
    eq_alert = true;
    replaceFeatures(map, "eq-waves", rings);
  } else if (eq_alert) {
    eq_alert = false;
    setFeatures(map, "eq-waves", []);
  }
}

/** Rebuild the flashing overlay from the latest RTS frame; `show` is the flash phase. */
export function refresh_box(show: boolean): void {
  // One write per tick, of the state the tick ends in. This used to empty the
  // source first and then fill it again on every visible tick — two tile
  // reloads every 500 ms, where the first never reached the screen.
  const map = variable.map;
  const rts = variable.data.rts;

  // No boxes to show, so nothing to stand in for them either.
  if (!rts?.box || !Object.keys(rts.box).length) {
    clearBoxes();
    clearEqWaves();
    return;
  }

  if (rts.eq?.length) {
    clearBoxes();
    refreshEqWaves(rts, rts.eq, show);
    return;
  }
  clearEqWaves();

  const boxFeatures: BoxFeature[] = [];
  if (show) {
    for (const area of getBoxes()) {
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

/** Register the box and wavefront sources/layers once the map has loaded. */
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

    map.addLayer({
      id: "box-geojson",
      type: "line",
      source: "box-geojson",
      paint: {
        "line-width": 2,
        "line-color": LEVEL_COLOR,
      },
    });

    map.addSource("eq-waves", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: [],
      },
      tolerance: 1,
      buffer: 128,
    });

    // Fainter than an EEW's rings: as wide as a box's edge, partly transparent.
    map.addLayer({
      id: "eq-waves",
      type: "line",
      source: "eq-waves",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "line-width": 2,
        "line-color": LEVEL_COLOR,
        "line-opacity": 0.6,
      },
    });
    map.addLayer({
      id: "eq-epicentres",
      type: "circle",
      source: "eq-waves",
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": 4,
        "circle-color": LEVEL_COLOR,
        "circle-opacity": 0.6,
      },
    });
  });
}
