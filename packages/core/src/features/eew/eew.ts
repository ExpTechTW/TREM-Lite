// Ported from legacy/src/js/index/core/eew.js
/**
 * EEW map driver — draws per-EEW P/S great-circle wavefronts and feeds the
 * (now React) info box via `ui.currentEew`. DOM writes live in React while
 * PiP, notifications and speech are handled by their cross-window clients.
 *
 * Each EEW's rings share one GeoJSON source, `waveSource(id)`: a P and an S
 * polygon, told apart by `ring`. Its three layers filter theirs out — the S
 * fill also reads `bg`, off while the map is dragged — so a wavefront tick is
 * one setData per EEW, and the S ring is tiled once, not twice.
 */
import type { ExpressionSpecification, Map as MlMap } from "maplibre-gl";

import { refresh_cross } from "@/features/cross/cross";
import { mouseDown } from "@/features/focus/focus";
import { COLOR } from "@/lib/constants";
import { events } from "@/lib/events";
import { replaceFeatures } from "@/lib/mapSource";
import { now, realNow } from "@/lib/ntp";
import type { Ans, EewData } from "@/lib/types";
import { ui } from "@/lib/variable.ui";
import { variable } from "@/lib/variable";

import { createCircleFeature, waveCalculator, waveSource } from "./waves";

type CachedEew = EewData & { cacheTime: number };

let eew_rotation = 0;
let initialized = false;
const eew_cache: Record<string, CachedEew> = {};
const EEW_CACHE_TTL = 600000; // 10 分鐘

const IS_P: ExpressionSpecification = ["==", ["get", "ring"], "p"];
const IS_S: ExpressionSpecification = ["==", ["get", "ring"], "s"];
const IS_S_BG: ExpressionSpecification = ["all", IS_S, ["==", ["get", "bg"], true]];

/** The S ring's outline and, beneath the county borders, its fill. */
function addSLayers(map: MlMap, id: string, color: string): void {
  map.addLayer({
    id: `${id}-s-wave-outline`,
    type: "line",
    source: waveSource(id),
    filter: IS_S,
    paint: { "line-color": color, "line-width": 2 },
  });
  map.addLayer(
    {
      id: `${id}-s-wave-background`,
      type: "fill",
      source: waveSource(id),
      filter: IS_S_BG,
      paint: { "fill-color": color, "fill-opacity": 0.25 },
    },
    "county",
  );
}

function createEewLayer(ans: Ans<EewData>): void {
  const map = variable.map;
  if (!map) return;
  const id = ans.data.id;

  if (!map.getSource(waveSource(id))) {
    map.addSource(waveSource(id), {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      tolerance: 1,
      buffer: 128,
    });
  }
  if (!map.getLayer(`${id}-p-wave-outline`)) {
    map.addLayer({
      id: `${id}-p-wave-outline`,
      type: "line",
      source: waveSource(id),
      filter: IS_P,
      paint: { "line-color": COLOR.EEW.P, "line-width": 1 },
    });
  }
  if (!map.getLayer(`${id}-s-wave-outline`)) {
    addSLayers(map, id, ans.data.status == 1 ? COLOR.EEW.S.ALERT : COLOR.EEW.S.WARN);
  }
  startWaves();
}

function removeEewLayersAndSources(eewId: string): void {
  const map = variable.map;
  if (!map) return;
  for (const layer of [`${eewId}-p-wave-outline`, `${eewId}-s-wave-outline`, `${eewId}-s-wave-background`]) {
    if (map.getLayer(layer)) map.removeLayer(layer);
  }
  if (map.getSource(waveSource(eewId))) map.removeSource(waveSource(eewId));
}

let waves: ReturnType<typeof setInterval> | null = null;

/** Grow every EEW's rings, every 100 ms while there is one to grow. */
function startWaves(): void {
  waves ??= setInterval(() => {
    const map = variable.map;
    if (!map || !variable.data.eew.length) {
      if (waves) clearInterval(waves);
      waves = null;
      return;
    }
    const calculator = waveCalculator();
    if (!calculator) return; // travel-time table still loading
    // 拖動地圖時不畫 S 波背景圈，避免拖動中閃爍（對應舊版 FocusManager.mouseDown()）。
    const bg = !mouseDown();
    for (const eew of variable.data.eew) {
      if (!map.getSource(waveSource(eew.id))) continue;
      const center: [number, number] = [eew.eq.lon, eew.eq.lat];
      const dist = calculator.psWaveDist(eew.eq.depth, eew.eq.time, now());
      eew.dist = dist;
      const p = createCircleFeature(center, dist.p_dist);
      const s = createCircleFeature(center, dist.s_dist);
      p.properties = { ring: "p" };
      s.properties = { ring: "s", bg };
      replaceFeatures(map, waveSource(eew.id), [p, s]);
    }
  }, 100);
}

/**
 * Refresh the EEW info box selection, rotating through multiple active EEWs.
 * `rts` imports this. `rotation` advances to the next EEW when true.
 */
export function show_eew(rotation = true): void {
  const count = variable.data.eew.length;
  const eew_list = Object.keys(eew_cache);

  if (count && eew_list.length) {
    variable.cache.show_eew_box = true;
    ui.currentTrigger = null;

    const eew = eew_cache[eew_list[eew_rotation]];
    if (eew) {
      ui.currentEew = {
        id: eew.id,
        statusClass: eew.status == 3 ? "eew-cancel" : eew.status == 1 ? "eew-alert" : "eew-warn",
        serial: eew.serial,
        final: !!eew.final,
        unitText: `${eew.author.toUpperCase()}${count == 1 ? "" : ` ${eew_rotation + 1}/${count}`}`,
        loc: eew.eq.loc,
        depth: eew.eq.depth,
        mag: eew.eq.mag,
        max: eew.eq.max,
        time: eew.eq.time,
      };
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
    eew_cache[ans.data.id] = { ...ans.data, cacheTime: realNow() };
    show_eew(false);
    createEewLayer(ans);
  });

  events.on("EewAlert", (ans) => {
    const map = variable.map;
    if (!map || !map.getSource(waveSource(ans.data.id))) return;
    // Removed and added again, not recoloured: they go back on top, as before.
    for (const layer of [`${ans.data.id}-s-wave-outline`, `${ans.data.id}-s-wave-background`]) {
      if (map.getLayer(layer)) map.removeLayer(layer);
    }
    addSLayers(map, ans.data.id, COLOR.EEW.S.ALERT);
  });

  events.on("EewUpdate", (ans) => {
    eew_cache[ans.data.id] = { ...ans.data, cacheTime: realNow() };

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
    const nowMs = realNow();
    for (const id of Object.keys(eew_cache)) {
      if (nowMs - eew_cache[id].cacheTime > EEW_CACHE_TTL) {
        removeEewLayersAndSources(id);
        delete eew_cache[id];
      }
    }
  }, 60000);

  // Rotate the info box through the active EEWs.
  setInterval(() => show_eew(), 5000);
}
