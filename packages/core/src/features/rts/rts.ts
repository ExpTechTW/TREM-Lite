// Ported from legacy/src/js/index/core/rts.js
import { type ExpressionSpecification, type GeoJSONSource } from "maplibre-gl";

import { COLOR, SHOW_REPORT, SHOW_TREM_EEW } from "@/lib/constants";
import { getConfig } from "@/lib/config";
import { events } from "@/lib/events";
import { variable } from "@/lib/variable";
import { ui } from "@/lib/variable.ui";
import type { ReportListItem, RtsStation } from "@/lib/types";
import { intensity_float_to_int, int_to_string, search_loc_name } from "@/domain/utils";
import { show_eew } from "@/features/eew/eew";
import { isAutoFocusLocked } from "@/features/focus/focus";
import { showReportPoint } from "@/features/report/report";

/**
 * Dev "no-strong-shaking / phantom" override table. Ported from
 * `TREM.constant.DEV_NSSPE` (constant.js). Empty station list = disabled.
 */
const DEV_NSSPE = { STATION: [] as string[], PGA_LEVEL: 8 };

/** Per-station rolling trigger peak (persists across DataRts frames). */
const level_list: Record<string, number> = {};

let initialized = false;

interface IntEntry {
  code: number;
  i: number;
}

interface TopIntensity {
  i: number;
  name: string;
}

interface IntCacheEntry {
  values: number[];
  lastUpdate: number;
}

interface RtsPointFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { i: number } | Record<string, never>;
}

/** Register the MapLoad (sources/layers) + DataRts (audio/geojson) handlers. */
export function initRts(): void {
  if (initialized) return;
  initialized = true;

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
        "circle-color": [
          "interpolate", ["linear"], ["get", "i"],
          -3, COLOR.RTS.intensity_3,
          -2, COLOR.RTS.intensity_2,
          -1, COLOR.RTS.intensity_1,
          0, COLOR.RTS.intensity0,
          1, COLOR.RTS.intensity1,
          2, COLOR.RTS.intensity2,
          3, COLOR.RTS.intensity3,
          4, COLOR.RTS.intensity4,
          5, COLOR.RTS.intensity5,
          6, COLOR.RTS.intensity6,
          7, COLOR.RTS.intensity7,
        ] as unknown as ExpressionSpecification,
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
    let data_list: RtsPointFeature[] = [];
    let data_alert_0_list: RtsPointFeature[] = [];
    let data_alert_list: RtsPointFeature[] = [];

    const coordinates: { lon: number; lat: number }[] = [];

    let pga = 0;
    let trigger = 0;
    let level = 0;
    let rts_max_pga = -1;
    let rts_max_shindo = -1;

    if (!variable.station) {
      return;
    }
    const stationMeta = variable.station;
    const config = getConfig();

    const eew_alert =
      variable.data.eew.length && SHOW_TREM_EEW
        ? true
        : variable.data.eew.some((item) => item.author != "trem");

    if (ans.data) {
      const rts = ans.data;
      let alert: number | boolean = rts.box ? Object.keys(rts.box).length : 0;

      let maxPgaKey: string | null = null;
      let maxPgaValue = -Infinity;
      let maxPgaStationData: RtsStation | null = null;

      for (const [key, station] of Object.entries(rts.station || {})) {
        if (station.pga > maxPgaValue) {
          maxPgaValue = station.pga;
          maxPgaKey = key;
          maxPgaStationData = station;
        }
      }

      if (!maxPgaStationData) {
        return;
      }

      alert = alert
        ? true
        : maxPgaStationData.pga > DEV_NSSPE.PGA_LEVEL &&
            (DEV_NSSPE.STATION.includes("all") ||
              (maxPgaKey !== null && DEV_NSSPE.STATION.includes(maxPgaKey)))
          ? true
          : false;

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

      for (const id of Object.keys(rts.station)) {
        const station_info = stationMeta[id];
        if (!station_info) {
          continue;
        }

        const st = rts.station[id];
        st.alert = st.alert
          ? true
          : st.pga > DEV_NSSPE.PGA_LEVEL &&
              (DEV_NSSPE.STATION.includes("all") || DEV_NSSPE.STATION.includes(id))
            ? true
            : false;

        const station_location = station_info.info.at(-1);
        if (!station_location) {
          continue;
        }

        if (st.pga > pga) {
          pga = st.pga;
        }

        if (Number(id) === config["realtime-station-id"]) {
          const I = alert && st.alert ? st.I : st.i;
          const loc = search_loc_name(station_location.code);
          ui.currentStation = {
            loc: loc ? `${loc.city}${loc.town}` : "",
            i: intensity_float_to_int(I),
            pga: st.pga,
          };
        }

        if (st.alert) {
          trigger++;
          if (!level_list[id] || level_list[id] < st.pga) {
            level_list[id] = st.pga;
          }
        } else {
          delete level_list[id];
        }

        if (alert && st.alert) {
          const I = intensity_float_to_int(st.I);

          if (variable.cache.show_intensity || variable.cache.show_lpgm) {
            data_list.push({
              type: "Feature",
              geometry: { type: "Point", coordinates: [station_location.lon, station_location.lat] },
              properties: { i: I },
            });
          } else if (I > 0) {
            data_alert_list.push({
              type: "Feature",
              geometry: { type: "Point", coordinates: [station_location.lon, station_location.lat] },
              properties: { i: I },
            });
          } else if (eew_alert && variable.data.eew) {
            data_alert_0_list.push({
              type: "Feature",
              geometry: { type: "Point", coordinates: [station_location.lon, station_location.lat] },
              properties: {},
            });
          } else {
            data_list.push({
              type: "Feature",
              geometry: { type: "Point", coordinates: [station_location.lon, station_location.lat] },
              properties: { i: I },
            });
          }

          coordinates.push({ lon: station_location.lon, lat: station_location.lat });

          if (rts_max_pga < st.pga) {
            rts_max_pga = st.pga;
          }
          if (rts_max_shindo < I) {
            rts_max_shindo = I;
          }

          if (pga > variable.cache.audio.pga) {
            if (pga > 200 && variable.cache.audio.status.pga != 2) {
              events.emit("RtsPga2");
              variable.cache.audio.status.pga = 2;
            } else if (pga > 8 && !variable.cache.audio.status.pga) {
              events.emit("RtsPga1");
              variable.cache.audio.status.pga = 1;
            }

            variable.cache.audio.pga = pga;
            if (pga > 8) {
              variable.cache.audio.count.pga_1 = 0;
            }
            if (pga > 200) {
              variable.cache.audio.count.pga_2 = 0;
            }
          }

          if (I > variable.cache.audio.shindo) {
            if (I > 3 && variable.cache.audio.status.shindo != 3) {
              events.emit("RtsShindo2");
              variable.cache.audio.status.shindo = 3;
            } else if (I > 1 && variable.cache.audio.status.shindo < 2) {
              events.emit("RtsShindo1");
              variable.cache.audio.status.shindo = 2;
            } else if (!variable.cache.audio.status.shindo) {
              events.emit("RtsShindo0");
              variable.cache.audio.status.shindo = 1;
            }

            if (I > 3) {
              variable.cache.audio.count.shindo_2 = 0;
            }
            if (I > 1) {
              variable.cache.audio.count.shindo_1 = 0;
            }
            variable.cache.audio.shindo = I;
          }
        } else if (!eew_alert) {
          data_list.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [station_location.lon, station_location.lat] },
            properties: { i: st.i },
          });
        }
      }

      if (variable.cache.audio.pga && rts_max_pga < variable.cache.audio.pga) {
        if (variable.cache.audio.status.pga == 2) {
          if (rts_max_pga < 200) {
            variable.cache.audio.count.pga_2++;
            if (variable.cache.audio.count.pga_2 >= 30) {
              variable.cache.audio.count.pga_2 = 0;
              variable.cache.audio.status.pga = 1;
            }
          } else {
            variable.cache.audio.count.pga_2 = 0;
          }
        } else if (variable.cache.audio.status.pga == 1) {
          if (rts_max_pga < 8) {
            variable.cache.audio.count.pga_1++;
            if (variable.cache.audio.count.pga_1 >= 30) {
              variable.cache.audio.count.pga_1 = 0;
              variable.cache.audio.status.pga = 0;
            }
          } else {
            variable.cache.audio.count.pga_1 = 0;
          }
        }

        variable.cache.audio.pga = rts_max_pga;
      }

      if (variable.cache.audio.shindo && rts_max_shindo < variable.cache.audio.shindo) {
        if (variable.cache.audio.status.shindo == 3) {
          if (rts_max_shindo < 4) {
            variable.cache.audio.count.shindo_2++;
            if (variable.cache.audio.count.shindo_2 >= 15) {
              variable.cache.audio.count.shindo_2 = 0;
              variable.cache.audio.status.shindo = 2;
            }
          } else {
            variable.cache.audio.count.shindo_2 = 0;
          }
        } else if (variable.cache.audio.status.shindo == 2) {
          if (rts_max_shindo < 2) {
            variable.cache.audio.count.shindo_1++;
            if (variable.cache.audio.count.shindo_1 >= 15) {
              variable.cache.audio.count.shindo_1 = 0;
              variable.cache.audio.status.shindo = 1;
            }
          } else {
            variable.cache.audio.count.shindo_1 = 0;
          }
        }

        variable.cache.audio.shindo = rts_max_shindo;
      }

      if (
        (rts.time ?? 0) - variable.cache.last_rts_alert < 15000 ||
        variable.cache.show_lpgm ||
        variable.cache.show_intensity ||
        eew_alert ||
        variable.play_mode == 2 ||
        variable.play_mode == 3
      ) {
        if (variable.cache.bounds.report) {
          variable.cache.bounds.report = [];
          const reportSrc = variable.map?.getSource("report-markers-geojson") as
            | GeoJSONSource
            | undefined;
          reportSrc?.setData({ type: "FeatureCollection", features: [] });
        }
      } else {
        if (SHOW_REPORT) {
          data_list = [];
          data_alert_0_list = [];
          data_alert_list = [];
          // 使用者鎖定地圖查看報告時不重畫報告點，避免打斷（對應舊版 rts.js:354）。
          if (!variable.cache.bounds.report.length || !isAutoFocusLocked()) {
            showReportPoint(variable.cache.last_report as ReportListItem | null);
          }
        }
      }
    }

    if (variable.map) {
      const map = variable.map;
      (map.getSource("rts") as GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        features: data_list,
      });
      (map.getSource("markers-geojson") as GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        features: data_alert_list,
      });
      (map.getSource("markers-geojson-0") as GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        features: data_alert_0_list,
      });
    }

    const int_list: IntEntry[] = ans.data?.int ?? [];

    // Side-effect: roll the per-code intensity history cache.
    updateIntensityHistory(int_list, ans.data?.time ?? 0);
    // TODO(react-overlay): render the sorted top-intensity list (was #rts-intensity-list);
    // a React component should read variable.data.rts.

    if (int_list.length) {
      // rts_trigger.loc holds {i,name} entries at runtime (contract types it as number[]).
      variable.cache.rts_trigger.loc = getTopIntensities(
        filterIntArray(int_list),
        8,
      ) as unknown as number[];
      variable.cache.rts_trigger.max = int_list[0].i;
      show_eew(false);
    } else {
      variable.cache.rts_trigger.loc = [];
    }

    const maxI = int_list[0]?.i ?? 0;
    ui.maxIntensity = { i: maxI, label: int_to_string(maxI) };
    ui.maxPga = pga;

    for (const id of Object.keys(level_list)) {
      level += level_list[id];
    }
    ui.rtsInfo = { level: Math.round(level), trigger };

    // bounds.rts holds {lon,lat} entries at runtime (contract types it as number[]).
    variable.cache.bounds.rts = coordinates as unknown as number[];

    ui.unstable =
      !!variable.cache.unstable &&
      (ans.data?.time ?? 0) - variable.cache.unstable < 300000;
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

function updateIntensityHistory(newData: IntEntry[], time: number): void {
  const cache = variable.cache.int_cache_list as Record<string, IntCacheEntry>;

  for (const int of newData) {
    if (!cache[int.code]) {
      cache[int.code] = { values: [], lastUpdate: time };
    }

    cache[int.code].values.push(int.i);
    cache[int.code].lastUpdate = time;

    if (cache[int.code].values.length > 45) {
      cache[int.code].values.shift();
    }
  }

  const cutoff = time - 30000;
  Object.keys(cache).forEach((code) => {
    if (cache[code].lastUpdate < cutoff) {
      delete cache[code];
    }
  });
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
