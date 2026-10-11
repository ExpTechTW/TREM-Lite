// Ported from legacy/src/js/index/core/rts.js
import { type ExpressionSpecification, type Map as MlMap } from "maplibre-gl";

import { COLOR, SHOW_REPORT } from "@/lib/constants";
import { getConfig, idleMap, onConfigUpdated } from "@/lib/config";
import { events } from "@/lib/events";
import { setFeatures } from "@/lib/mapSource";
import { eventHoldsMap, variable } from "@/lib/variable";
import { ui } from "@/lib/variable.ui";
import type { ReportListItem } from "@/lib/types";
import { intensity_float_to_int, int_to_string, search_loc_name } from "@/domain/utils";
import { show_eew } from "@/features/eew/eew";
import { isAutoFocusLocked } from "@/features/focus/focus";
import { forgetReportPoint, reportPointShown, showReportPoint } from "@/features/report/report";

import { RTS_PALETTE, rtsColorIndex } from "./palette";
import { shakeLevel, type ShakePoint } from "./shakeLevel";
import { TownPeaks } from "./townPeaks";

let initialized = false;

/** The bottom-right ranking's 60 s memory; everything else reads each frame as it comes. */
const townPeaks = new TownPeaks(search_loc_name);

interface IntEntry {
  code: number;
  i: number;
}

interface TopIntensity {
  i: number;
  name: string;
}

/**
 * One station on the map. `kind` 1 is a coloured dot (`v` indexes RTS_PALETTE),
 * 2 an alert icon (`v` is the integer level), 3 a zero dot while an EEW is up.
 * Reused across frames so a quiet second allocates nothing.
 */
interface Dot {
  kind: number;
  v: number;
  lon: number;
  lat: number;
}

const dots: Dot[] = [];
const prevDots: Dot[] = [];
let dotCount = 0;
let prevDotCount = 0;
/** The map lost its picture (context gone, or a mode change) and must be drawn again. */
let dotsNeedDraw = true;

const shakeBuf: ShakePoint[] = [];

function pushDot(kind: number, v: number, lon: number, lat: number): void {
  const d = dots[dotCount];
  if (d) {
    d.kind = kind;
    d.v = v;
    d.lon = lon;
    d.lat = lat;
  } else {
    dots[dotCount] = { kind, v, lon, lat };
  }
  dotCount++;
}

function dotsChanged(): boolean {
  if (dotCount !== prevDotCount) return true;
  for (let i = 0; i < dotCount; i++) {
    const a = dots[i];
    const b = prevDots[i];
    if (a.kind !== b.kind || a.v !== b.v || a.lon !== b.lon || a.lat !== b.lat) return true;
  }
  return false;
}

function commitDots(): void {
  while (prevDots.length < dotCount) prevDots.push({ kind: 0, v: 0, lon: 0, lat: 0 });
  for (let i = 0; i < dotCount; i++) {
    const a = dots[i];
    const b = prevDots[i];
    b.kind = a.kind;
    b.v = a.v;
    b.lon = a.lon;
    b.lat = a.lat;
  }
  prevDotCount = dotCount;
}

/** Write the three station sources. Called only when the picture changed. */
function publishDots(map: MlMap): void {
  const rts: GeoJSON.Feature[] = [];
  const alert: GeoJSON.Feature[] = [];
  const zero: GeoJSON.Feature[] = [];
  for (let i = 0; i < dotCount; i++) {
    const d = dots[i];
    const feature: GeoJSON.Feature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [d.lon, d.lat] },
      properties: d.kind === 1 ? { c: RTS_PALETTE[d.v] } : d.kind === 2 ? { i: d.v } : {},
    };
    if (d.kind === 1) rts.push(feature);
    else if (d.kind === 2) alert.push(feature);
    else zero.push(feature);
  }
  setFeatures(map, "rts", rts);
  setFeatures(map, "markers-geojson", alert);
  setFeatures(map, "markers-geojson-0", zero);
  commitDots();
  dotsNeedDraw = false;
}

/** Copy the last published station picture back so this frame does not wipe it. */
function restorePublishedDots(): void {
  dotCount = prevDotCount;
  for (let i = 0; i < prevDotCount; i++) {
    const b = prevDots[i];
    const a = dots[i];
    if (a) {
      a.kind = b.kind;
      a.v = b.v;
      a.lon = b.lon;
      a.lat = b.lat;
    } else {
      dots[i] = { kind: b.kind, v: b.v, lon: b.lon, lat: b.lat };
    }
  }
}

/** 閒置改看測站時，拿掉已經畫上的報告。沒有報告就不動那個來源。 */
function dropIdleReport(): void {
  if (!reportPointShown() && variable.cache.bounds.report.length === 0) return;
  variable.cache.bounds.report = [];
  forgetReportPoint();
  if (variable.map) setFeatures(variable.map, "report-markers-geojson", []);
}

/** Register the MapLoad (sources/layers) + DataRts (audio/geojson) handlers. */
export function initRts(): void {
  if (initialized) return;
  initialized = true;

  events.on("DataModeReset", () => {
    ui.currentStation = null;
    ui.rtsInfo = { level: 0, trigger: 0 };
    ui.rtsIntensityRows = [];
    townPeaks.clear();
    ui.maxIntensity = { i: 0, label: int_to_string(0) };
    ui.maxPga = 0;
    ui.maxPgaIntensity = 0;
    ui.unstable = false;
    dotsNeedDraw = true;
    forgetReportPoint();
  });

  events.on("MapLoad", () => {
    const map = variable.map;
    if (!map) return;

    map.addSource("markers-geojson", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addSource("markers-geojson-0", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addSource("rts", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

    const circleRadius = [
      "interpolate", ["linear"], ["zoom"],
      4, 2,
      12, 8,
    ] as unknown as ExpressionSpecification;

    map.addLayer({
      id: "rts-layer",
      type: "circle",
      source: "rts",
      paint: {
        // The colour is baked into each dot (`c`). A 100-stop step expression
        // here was evaluated for every station on every redraw.
        "circle-color": ["get", "c"] as ExpressionSpecification,
        "circle-radius": circleRadius,
      },
    });

    map.addLayer({
      id: "markers-0",
      type: "circle",
      source: "markers-geojson-0",
      paint: {
        "circle-color": COLOR.INTENSITY[0],
        "circle-radius": circleRadius,
      },
    });

    map.addLayer({
      id: "markers",
      type: "symbol",
      source: "markers-geojson",
      layout: {
        "symbol-sort-key": ["get", "i"] as unknown as ExpressionSpecification,
        "symbol-z-order": "source",
        "icon-image": [
          "match", ["get", "i"],
          1, "intensity-1",
          2, "intensity-2",
          3, "intensity-3",
          4, "intensity-4",
          5, "intensity-5",
          6, "intensity-6",
          7, "intensity-7",
          8, "intensity-8",
          9, "intensity-9",
          "intensity-0",
        ] as unknown as ExpressionSpecification,
        "icon-size": [
          "interpolate", ["linear"], ["zoom"],
          5, 0.2,
          10, 0.6,
        ] as unknown as ExpressionSpecification,
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    });
  });

  events.on("DataRts", (ans) => {
    const coordinates: { lon: number; lat: number }[] = [];

    let pga = 0;
    let trigger = 0;
    let level = 0;
    let rts_max_pga = -1;
    let rts_max_shindo = -1;
    let shakeN = 0;
    dotCount = 0;

    if (!variable.station) {
      return;
    }
    const stationMeta = variable.station;
    const config = getConfig();

    const eew_alert = variable.data.eew.length > 0;
    let alert = false;

    if (ans.data) {
      const rts = ans.data;
      // A frame without a single station reading is ignored.
      const stations = rts.station || {};
      let readable = false;
      for (const id in stations) {
        if (stations[id].pga > -Infinity) {
          readable = true;
          break;
        }
      }
      if (!readable) return;
      // Legacy also raised the alert from a dev override table of "phantom"
      // stations (DEV_NSSPE); it was ported empty and never filled, so only
      // the box list decides.
      alert = !!rts.box && Object.keys(rts.box).length > 0;

      if (!alert) {
        variable.cache.rts_alert = false;
        variable.cache.audio = {
          shindo: -1,
          pga: -1,
          status: { shindo: 0, pga: 0 },
          count: { pga_1: 0, pga_2: 0, shindo_1: 0, shindo_2: 0 },
        };
      } else {
        if (
          !variable.cache.rts_alert &&
          variable.cache.last_rts_alert &&
          (rts.time ?? 0) - variable.cache.last_rts_alert < 300000
        ) {
          variable.cache.unstable = rts.time;
        }
        variable.cache.last_rts_alert = rts.time ?? 0;
        variable.cache.rts_alert = true;
      }
      // Nothing the loop below calls replaces this object, so one reference serves.
      const audio = variable.cache.audio;
      // String(): YAML reads an all-digit hex id back as a number.
      const ownStation = String(config["realtime-station-id"]);

      for (const id in rts.station) {
        const station_info = stationMeta[id];
        if (!station_info) {
          continue;
        }

        const st = rts.station[id];
        st.alert = !!st.alert;

        const station_location = station_info.info.at(-1);
        if (!station_location) {
          continue;
        }

        if (st.pga > pga) {
          pga = st.pga;
        }

        if (id === ownStation) {
          const loc = search_loc_name(station_location.code);
          ui.currentStation = {
            loc: loc ? `${loc.city}${loc.town}` : "",
            i: intensity_float_to_int(st.i),
            rawI: st.i,
            pga: st.pga,
          };
        }

        const spot = shakeBuf[shakeN];
        if (spot) {
          spot.lon = station_location.lon;
          spot.lat = station_location.lat;
          spot.i = st.i;
        } else {
          shakeBuf[shakeN] = { lon: station_location.lon, lat: station_location.lat, i: st.i };
        }
        shakeN++;

        if (st.alert) {
          trigger++;
        }

        if (alert && st.alert) {
          const I = intensity_float_to_int(st.i);
          const lon = station_location.lon;
          const lat = station_location.lat;

          if (variable.cache.show_intensity || variable.cache.show_lpgm) {
            pushDot(1, rtsColorIndex(I), lon, lat);
          } else if (I > 0) {
            pushDot(2, I, lon, lat);
          } else if (eew_alert) {
            pushDot(3, 0, lon, lat);
          } else {
            pushDot(1, rtsColorIndex(I), lon, lat);
          }

          coordinates.push({ lon, lat });

          if (rts_max_pga < st.pga) {
            rts_max_pga = st.pga;
          }
          if (rts_max_shindo < I) {
            rts_max_shindo = I;
          }

          if (pga > audio.pga) {
            if (pga > 200 && audio.status.pga != 2) {
              events.emit("RtsPga2");
              audio.status.pga = 2;
            } else if (pga > 8 && !audio.status.pga) {
              events.emit("RtsPga1");
              audio.status.pga = 1;
            }

            audio.pga = pga;
            if (pga > 8) {
              audio.count.pga_1 = 0;
            }
            if (pga > 200) {
              audio.count.pga_2 = 0;
            }
          }

          if (I > audio.shindo) {
            if (I > 3 && audio.status.shindo != 3) {
              events.emit("RtsShindo2");
              audio.status.shindo = 3;
            } else if (I > 1 && audio.status.shindo < 2) {
              events.emit("RtsShindo1");
              audio.status.shindo = 2;
            } else if (!audio.status.shindo) {
              events.emit("RtsShindo0");
              audio.status.shindo = 1;
            }

            if (I > 3) {
              audio.count.shindo_2 = 0;
            }
            if (I > 1) {
              audio.count.shindo_1 = 0;
            }
            audio.shindo = I;
          }
        } else if (!eew_alert) {
          pushDot(1, rtsColorIndex(st.i), station_location.lon, station_location.lat);
        }
      }

      // Every station scores, alerting or not: quiet ones sit below 0 and add
      // nothing (see shakeLevel.ts).
      shakeBuf.length = shakeN;
      level = shakeLevel(shakeBuf);

      if (audio.pga && rts_max_pga < audio.pga) {
        if (audio.status.pga == 2) {
          if (rts_max_pga < 200) {
            audio.count.pga_2++;
            if (audio.count.pga_2 >= 30) {
              audio.count.pga_2 = 0;
              audio.status.pga = 1;
            }
          } else {
            audio.count.pga_2 = 0;
          }
        } else if (audio.status.pga == 1) {
          if (rts_max_pga < 8) {
            audio.count.pga_1++;
            if (audio.count.pga_1 >= 30) {
              audio.count.pga_1 = 0;
              audio.status.pga = 0;
            }
          } else {
            audio.count.pga_1 = 0;
          }
        }

        audio.pga = rts_max_pga;
      }

      if (audio.shindo && rts_max_shindo < audio.shindo) {
        if (audio.status.shindo == 3) {
          if (rts_max_shindo < 4) {
            audio.count.shindo_2++;
            if (audio.count.shindo_2 >= 15) {
              audio.count.shindo_2 = 0;
              audio.status.shindo = 2;
            }
          } else {
            audio.count.shindo_2 = 0;
          }
        } else if (audio.status.shindo == 2) {
          if (rts_max_shindo < 2) {
            audio.count.shindo_1++;
            if (audio.count.shindo_1 >= 15) {
              audio.count.shindo_1 = 0;
              audio.status.shindo = 1;
            }
          } else {
            audio.count.shindo_1 = 0;
          }
        }

        audio.shindo = rts_max_shindo;
      }

      if (
        (rts.time ?? 0) - variable.cache.last_rts_alert < 15000 ||
        variable.cache.show_lpgm ||
        variable.cache.show_intensity ||
        eew_alert ||
        variable.play_mode == 2 ||
        variable.play_mode == 3
      ) {
        variable.cache.bounds.report = [];
        forgetReportPoint();
        if (variable.map) setFeatures(variable.map, "report-markers-geojson", []);
      } else if (SHOW_REPORT && idleMap(config) === "report") {
        dotCount = 0;
        // 使用者鎖定地圖查看報告時不重畫報告點，避免打斷（對應舊版 rts.js:354）。
        if (!variable.cache.bounds.report.length || !isAutoFocusLocked()) {
          showReportPoint(variable.cache.last_report as ReportListItem | null);
        }
      } else if (idleMap(config) === "rts") {
        // 閒置改看即時測站：這一幀算好的點留著，報告的震度與震央拿掉。
        dropIdleReport();
      }
    }

    // 沒有新的測站幀、又選了即時測站、而且沒有地震占著地圖：
    // 不要把上一幀的點清成空的，下面也不改放報告。
    const keepStationDots =
      !ans.data && variable.play_mode === 0 && idleMap(config) === "rts" && !eventHoldsMap();
    if (keepStationDots) restorePublishedDots();

    // Same colours and places as last frame: the map already shows them.
    // Writing the sources again would retile and redraw for nothing.
    if (!variable.map) {
      dotsNeedDraw = true;
      forgetReportPoint();
    }
    else if (dotsNeedDraw || dotsChanged()) publishDots(variable.map);

    // No station data while live — a lost connection, or just
    // back from a replay — falls back to the latest report, as an idle frame
    // does. Otherwise the replay's markers leave with nothing in their place.
    // Idle RTS keeps the station dots instead of that report.
    if (!ans.data && variable.play_mode === 0 && SHOW_REPORT) {
      if (keepStationDots) dropIdleReport();
      else if (!variable.cache.bounds.report.length || !isAutoFocusLocked()) {
        showReportPoint(variable.cache.last_report as ReportListItem | null);
      }
    }

    // This frame's highest level per town. The maximum intensity and the
    // trigger box read it as is; only the bottom-right ranking holds each
    // town's peak for 60 s. A frame without data (a lost connection, a mode
    // boundary) leaves the ranking as it was.
    const int_list: IntEntry[] = ans.data?.int ?? [];
    if (ans.data) {
      ui.rtsIntensityRows = getTopIntensities(townPeaks.update(int_list, ans.data.time ?? 0)).sort(
        (a, b) => b.i - a.i,
      );
    }

    if (int_list.length) {
      variable.cache.rts_trigger.loc = getTopIntensities(
        filterIntArray(int_list),
        8,
      );
      variable.cache.rts_trigger.max = int_list[0].i;
      show_eew(false);
    } else {
      variable.cache.rts_trigger.loc = [];
    }

    const maxI = int_list[0]?.i ?? 0;
    ui.maxIntensity = { i: maxI, label: int_to_string(maxI) };
    ui.maxPga = pga;
    ui.maxPgaIntensity =
      alert && pga >= 5
        ? intensity_float_to_int(2 * Math.log10(pga) + 0.7)
        : 0;

    ui.rtsInfo = { level, trigger };

    // bounds.rts holds {lon,lat} entries at runtime (contract types it as number[]).
    variable.cache.bounds.rts = coordinates as unknown as number[];

    ui.unstable =
      !!variable.cache.unstable &&
      (ans.data?.time ?? 0) - variable.cache.unstable < 300000;
  });

  // 無地震時的地圖改了就立刻重畫。地震進行中不換畫面，回到閒置的下一幀會用新的選擇。
  let idleShown = idleMap();
  void onConfigUpdated(() => {
    const next = idleMap();
    if (next === idleShown) return;
    idleShown = next;
    if (eventHoldsMap()) return;
    events.emit("DataRts", { info: { type: variable.play_mode }, data: variable.data.rts });
  });
}

function filterIntArray(data: IntEntry[] = []): IntEntry[] {
  const maxValue = data[0].i;

  if (maxValue > 3) {
    return data.filter((value) => value.i > 3);
  } else if (maxValue > 1) {
    return data.filter((value) => value.i > 1);
  }

  return data;
}

function getTopIntensities(intensities: IntEntry[], maxCount = 6): TopIntensity[] {
  if (intensities.length <= maxCount) {
    return intensities.map((loc) => {
      const name = search_loc_name(loc.code);
      return {
        i: loc.i,
        name: name ? `${name.city}${name.town}` : "",
      };
    });
  }

  const cityGroups = new Map<string, TopIntensity>();
  intensities.forEach((loc) => {
    const name = search_loc_name(loc.code);
    if (!name) {
      return;
    }

    const current = cityGroups.get(name.city);
    if (!current || loc.i > current.i) {
      cityGroups.set(name.city, { i: loc.i, name: name.city });
    }
  });

  return Array.from(cityGroups.values())
    .sort((a, b) => b.i - a.i)
    .slice(0, maxCount);
}
