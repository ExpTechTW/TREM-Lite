// Ported from legacy/src/js/index/core/eew.js
/**
 * EEW map driver — draws per-EEW P/S great-circle wavefronts and feeds the
 * (now React) info box via `ui.currentEew`. DOM writes live in React while
 * PiP, notifications and speech are handled by their cross-window clients.
 */
import type { GeoJSONSource } from "maplibre-gl";

import { EEWCalculator } from "@/domain/eewCalculator";
import type { TimeTable } from "@/domain/eewCalculator";
import { refresh_cross } from "@/features/cross/cross";
import { mouseDown } from "@/features/focus/focus";
import { COLOR, SHOW_TREM_EEW } from "@/lib/constants";
import { events } from "@/lib/events";
import { now } from "@/lib/ntp";
import type { Ans, EewData } from "@/lib/types";
import { ui } from "@/lib/variable.ui";
import { variable } from "@/lib/variable";
import timeBinUrl from "@/data/time.bin?url";
import { decodeTimeTable } from "@/lib/bindata";

// P/S travel-time table, loaded from the compact binary (scripts/encode-data.mjs
// + lib/bindata.ts) instead of inlining the 1 MB JSON into the bundle. Async —
// only needed once an EEW is active, which is long after startup.
let calculator: EEWCalculator | null = null;
void fetch(timeBinUrl)
  .then((r) => r.arrayBuffer())
  .then((buf) => {
    calculator = new EEWCalculator(decodeTimeTable(buf) as TimeTable);
  })
  .catch(() => {});

type CachedEew = EewData & { cacheTime: number; rts?: boolean };

let flash = false;
let eew_rotation = 0;
let draw_lock = false;
let initialized = false;
const eew_cache: Record<string, CachedEew> = {};
const EEW_CACHE_TTL = 600000; // 10 分鐘

/** Empty / wrapped GeoJSON helpers. */
function fc(features: GeoJSON.Feature[] = []): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features };
}

function getGeoSource(id: string): GeoJSONSource | undefined {
  return variable.map?.getSource(id) as GeoJSONSource | undefined;
}

function createEewLayer(ans: Ans<EewData>): void {
  const map = variable.map;
  if (!map) return;

  if (!map.getSource(`${ans.data.id}-s-wave`)) {
    map.addSource(`${ans.data.id}-s-wave`, { type: "geojson", data: fc(), tolerance: 1, buffer: 128 });
  }
  if (!map.getSource(`${ans.data.id}-p-wave`)) {
    map.addSource(`${ans.data.id}-p-wave`, { type: "geojson", data: fc(), tolerance: 1, buffer: 128 });
  }
  if (!map.getSource(`${ans.data.id}-s-wave-bg`)) {
    map.addSource(`${ans.data.id}-s-wave-bg`, { type: "geojson", data: fc(), tolerance: 1, buffer: 128 });
  }

  const isTrem = !SHOW_TREM_EEW && ans.data.author == "trem";

  if (!map.getLayer(`${ans.data.id}-p-wave-outline`)) {
    map.addLayer({
      id: `${ans.data.id}-p-wave-outline`,
      type: "line",
      source: `${ans.data.id}-p-wave`,
      paint: {
        "line-color": COLOR.EEW.P,
        "line-width": isTrem ? 0.2 : 1,
      },
    });
  }

  const color = isTrem
    ? COLOR.TREM.S
    : ans.data.status == 1
      ? COLOR.EEW.S.ALERT
      : COLOR.EEW.S.WARN;

  if (!map.getLayer(`${ans.data.id}-s-wave-outline`)) {
    map.addLayer({
      id: `${ans.data.id}-s-wave-outline`,
      type: "line",
      source: `${ans.data.id}-s-wave`,
      paint: {
        "line-color": color,
        "line-width": isTrem ? 0.6 : 2,
      },
    });
  }

  if (!map.getLayer(`${ans.data.id}-s-wave-background`)) {
    map.addLayer(
      {
        id: `${ans.data.id}-s-wave-background`,
        type: "fill",
        source: `${ans.data.id}-s-wave-bg`,
        paint: {
          "fill-color": isTrem ? COLOR.TREM.P : color,
          "fill-opacity": isTrem ? 0 : 0.25,
        },
      },
      "county",
    );
  }
}

/** Build a 256-point great-circle polygon (km radius) around `center`. */
function createCircleFeature(
  center: [number, number],
  radius: number,
  steps = 256,
): GeoJSON.Feature<GeoJSON.Polygon> {
  const coordinates: number[][][] = [[]];
  const km = radius;

  for (let i = 0; i <= steps; i++) {
    const angle = (i * 360) / steps;
    const rad = (angle * Math.PI) / 180;

    const delta = km / 6371;
    const phi1 = (center[1] * Math.PI) / 180;
    const lambda1 = (center[0] * Math.PI) / 180;
    const theta = rad;

    const phi2 = Math.asin(
      Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta),
    );

    const lambda2 =
      lambda1 +
      Math.atan2(
        Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
        Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
      );

    const lat = (phi2 * 180) / Math.PI;
    const lng = (lambda2 * 180) / Math.PI;

    coordinates[0].push([lng, lat]);
  }

  coordinates[0].push(coordinates[0][0]);

  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates,
    },
  };
}

function removeEewLayersAndSources(eewId: string): void {
  const map = variable.map;
  if (!map) return;

  const layerIds = [
    `${eewId}-p-wave-outline`,
    `${eewId}-s-wave-outline`,
    `${eewId}-s-wave-background`,
  ];

  const sourceIds = [`${eewId}-s-wave`, `${eewId}-s-wave-bg`, `${eewId}-p-wave`];

  layerIds.forEach((layerId) => {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  });

  sourceIds.forEach((sourceId) => {
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  });
}

/**
 * Refresh the EEW info box selection, rotating through multiple active EEWs.
 * `rts` imports this. `rotation` advances to the next EEW when true.
 */
export function show_eew(rotation = true): void {
  let count = 0;
  const eew_list = Object.keys(eew_cache);

  for (const eew of variable.data.eew) {
    if (!SHOW_TREM_EEW && eew.author == "trem") continue;
    count++;
  }

  if (count && eew_list.length) {
    variable.cache.show_eew_box = true;
    ui.currentTrigger = null;

    if (eew_cache[eew_list[eew_rotation]]) {
      if (!SHOW_TREM_EEW && eew_cache[eew_list[eew_rotation]].author == "trem") {
        eew_rotation++;
        if (eew_rotation >= eew_list.length) eew_rotation = 0;
      } else {
        const eew = eew_cache[eew_list[eew_rotation]];
        const statusClass =
          eew.status == 3
            ? "eew-cancel"
            : eew.status == 1
              ? "eew-alert"
              : eew.author == "trem" && !eew.rts
                ? "eew-rts"
                : "eew-warn";

        ui.currentEew = {
          id: eew.id,
          statusClass,
          serial: eew.serial,
          final: !!eew.final,
          unitText: `${eew.author.toUpperCase()}${count == 1 ? "" : ` ${eew_rotation + 1}/${count}`}`,
          loc: eew.eq.loc,
          depth: eew.eq.depth,
          mag: eew.eq.mag,
          max: eew.eq.max,
          nsspe: eew.eq.mag == 1,
          time: eew.eq.time,
        };
      }
      variable.last_rotation = eew_rotation;
    }

    if (rotation) {
      eew_rotation++;
      if (eew_rotation >= eew_list.length) eew_rotation = 0;
    }
  } else {
    variable.cache.show_eew_box = false;
    ui.currentEew = null;

    const locationArray = variable.cache.rts_trigger.loc;
    if (locationArray.length) {
      ui.currentTrigger = {
        max: variable.cache.rts_trigger.max,
        locations: locationArray.slice(0, 8),
      };
    } else {
      variable.last_rotation = 0; // was null in the Electron app
      ui.currentTrigger = null;
    }
  }
  // ui.currentEew 已更新，通知 EewInfoBox 事件驅動刷新。
  events.emit("EewDisplayUpdate");
}

/**
 * Register EEW event subscriptions and start the animation/rotation timers.
 * Replaces the legacy auto-run-on-require behavior. Idempotent.
 */
export function initEew(): void {
  if (initialized) return;
  initialized = true;

  events.on("EewRelease", (ans) => {
    eew_cache[ans.data.id] = { ...ans.data, cacheTime: Date.now() };
    show_eew(false);
    createEewLayer(ans);
  });

  events.on("EewAlert", (ans) => {
    const map = variable.map;
    if (!map) return;

    if (map.getLayer(`${ans.data.id}-s-wave-outline`)) {
      map.removeLayer(`${ans.data.id}-s-wave-outline`);
    }
    if (map.getLayer(`${ans.data.id}-s-wave-background`)) {
      map.removeLayer(`${ans.data.id}-s-wave-background`);
    }

    const isTrem = !SHOW_TREM_EEW && ans.data.author == "trem";
    const color = isTrem ? COLOR.TREM.S : COLOR.EEW.S.ALERT;

    map.addLayer({
      id: `${ans.data.id}-s-wave-outline`,
      type: "line",
      source: `${ans.data.id}-s-wave`,
      paint: {
        "line-color": color,
        "line-width": isTrem ? 0.6 : 2,
      },
    });

    map.addLayer(
      {
        id: `${ans.data.id}-s-wave-background`,
        type: "fill",
        source: `${ans.data.id}-s-wave-bg`,
        paint: {
          "fill-color": color,
          "fill-opacity": isTrem ? 0 : 0.25,
        },
      },
      "county",
    );
  });

  events.on("EewUpdate", (ans) => {
    eew_cache[ans.data.id] = { ...ans.data, cacheTime: Date.now() };

    createEewLayer(ans);

    show_eew(false);
    refresh_cross(false);

    if (eew_cache[ans.data.id].status == 3) {
      removeEewLayersAndSources(ans.data.id);
    }
  });

  events.on("EewEnd", (ans) => {
    removeEewLayersAndSources(ans.data.id);
    delete eew_cache[ans.data.id];
    show_eew(true);
  });

  // Periodically drop expired EEW caches.
  setInterval(() => {
    const nowMs = Date.now();
    for (const id of Object.keys(eew_cache)) {
      if (nowMs - eew_cache[id].cacheTime > EEW_CACHE_TTL) {
        removeEewLayersAndSources(id);
        delete eew_cache[id];
      }
    }
  }, 60000);

  // nsspe 波前閃爍跟隨中央 Flash 節拍（loop.ts），不另開計時器。
  events.on("Flash", (v) => {
    flash = v;
  });

  // Animate the P/S wavefronts.
  setInterval(() => {
    if (draw_lock) return;
    const map = variable.map;
    if (!map) return;
    if (!calculator) return; // travel-time table still loading
    draw_lock = true;

    const alert = variable.data.eew.some((eew) => eew.author != "trem");

    // 拖動地圖時不畫 S 波背景圈，避免拖動中閃爍（對應舊版 FocusManager.mouseDown()）。
    const isMouseDown = mouseDown();

    for (const eew of variable.data.eew) {
      if (!SHOW_TREM_EEW && eew.author == "trem") {
        const sWaveSource = getGeoSource(`${eew.id}-s-wave`);
        const sWaveSourceBg = getGeoSource(`${eew.id}-s-wave-bg`);
        const pWaveSource = getGeoSource(`${eew.id}-p-wave`);
        if (sWaveSource && sWaveSourceBg && pWaveSource) {
          const center: [number, number] = [eew.eq.lon, eew.eq.lat];
          const dist = calculator.psWaveDist(eew.eq.depth, eew.eq.time, now());

          if (!alert && flash) {
            sWaveSource.setData(fc([createCircleFeature(center, dist.s_dist)]));
            sWaveSourceBg.setData(fc(isMouseDown ? [] : [createCircleFeature(center, dist.s_dist)]));
            pWaveSource.setData(fc([createCircleFeature(center, dist.p_dist)]));
          } else {
            sWaveSource.setData(fc());
            sWaveSourceBg.setData(fc());
            pWaveSource.setData(fc());
          }
        }
        continue;
      }

      if (eew.eq.mag == 1) continue;

      const sWaveSource = getGeoSource(`${eew.id}-s-wave`);
      const sWaveSourceBg = getGeoSource(`${eew.id}-s-wave-bg`);
      const pWaveSource = getGeoSource(`${eew.id}-p-wave`);

      if (sWaveSource && sWaveSourceBg && pWaveSource) {
        const center: [number, number] = [eew.eq.lon, eew.eq.lat];
        const dist = calculator.psWaveDist(eew.eq.depth, eew.eq.time, now());
        eew.dist = dist;
        sWaveSource.setData(fc([createCircleFeature(center, dist.s_dist)]));
        sWaveSourceBg.setData(fc(isMouseDown ? [] : [createCircleFeature(center, dist.s_dist)]));
        pWaveSource.setData(fc([createCircleFeature(center, dist.p_dist)]));
      }
    }
    draw_lock = false;
  }, 100);

  // Rotate the info box through the active EEWs.
  setInterval(() => show_eew(), 5000);
}
