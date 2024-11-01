const TREM = require("../constant");

const EEWCalculator = require("../utils/eewCalculator");

const { intensity_float_to_int, search_loc_name } = require("../utils/utils");

const calculator = new EEWCalculator();

const rts_intensity_list = document.getElementById("rts-intensity-list");
const max_pga = document.getElementById("max-pga");
const max_intensity = document.getElementById("max-intensity");
const current_station_loc = document.getElementById("current-station-loc");
const current_station_pga = document.getElementById("current-station-pga");
const current_station_intensity = document.getElementById("current-station-intensity");
const current_station_intensity_text = document.getElementById("current-station-intensity-text");

const int_cache_list = {};

TREM.variable.events.on("MapLoad", (map) => {
  map.addLayer({
    id     : "rts-layer",
    type   : "circle",
    source : "rts",
    paint  : {
      "circle-color": [
        "interpolate",
        ["linear"],
        ["get", "i"],
        -3, TREM.constant.COLOR.RTS.intensity_3,
        -2, TREM.constant.COLOR.RTS.intensity_2,
        -1, TREM.constant.COLOR.RTS.intensity_1,
        0, TREM.constant.COLOR.RTS.intensity0,
        1, TREM.constant.COLOR.RTS.intensity1,
        2, TREM.constant.COLOR.RTS.intensity2,
        3, TREM.constant.COLOR.RTS.intensity3,
        4, TREM.constant.COLOR.RTS.intensity4,
        5, TREM.constant.COLOR.RTS.intensity5,
        6, TREM.constant.COLOR.RTS.intensity6,
        7, TREM.constant.COLOR.RTS.intensity7,
      ],
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        4, 2,
        12, 8,
      ],
    },
  });

  map.addLayer({
    id     : "markers-0",
    type   : "circle",
    source : "markers-geojson-0",
    paint  : {
      "circle-color"  : TREM.constant.COLOR.INTENSITY[0],
      "circle-radius" : [
        "interpolate",
        ["linear"],
        ["zoom"],
        4, 2,
        12, 8,
      ],
    },
  });

  map.addLayer({
    id     : "markers",
    type   : "symbol",
    source : "markers-geojson",
    layout : {
      "symbol-sort-key" : ["get", "i"],
      "symbol-z-order"  : "source",
      "icon-image"      : [
        "match",
        ["get", "i"],
        2, "intensity-2",
        3, "intensity-3",
        4, "intensity-4",
        5, "intensity-5",
        6, "intensity-6",
        7, "intensity-7",
        8, "intensity-8",
        9, "intensity-9",
        "intensity-1",
      ],
      "icon-size": [
        "interpolate",
        ["linear"],
        ["zoom"],
        5, 0.2,
        10, 0.6,
      ],
      "icon-allow-overlap"    : true,
      "icon-ignore-placement" : true,
    },
  });
});

TREM.variable.events.on("DataRts", (ans) => {
  const data_list = [];
  const data_alert_0_list = [];
  const data_alert_list = [];

  const coordinates = [];

  let pga = 0;

  if (!TREM.variable.station) return;

  const eew_alert = (TREM.variable.data.eew.length && TREM.constant.SHOW_TREM_EEW) ? true : TREM.variable.data.eew.some(item => item.author != "trem");

  if (ans.data) {
    const alert = Object.keys(ans.data.box).length;

    for (const id of Object.keys(ans.data.station)) {
      const station_info = TREM.variable.station[id];
      if (!station_info) continue;
      const station_location = station_info.info.at(-1);

      if (ans.data.station[id].pga > pga) pga = ans.data.station[id].pga;

      if (id == TREM.variable.rts_station_id) {
        const I = (alert && ans.data.station[id].alert) ? ans.data.station[id].I : ans.data.station[id].i;
        const loc = search_loc_name(station_location.code);
        current_station_loc.textContent = `${loc.city}${loc.town}`;
        current_station_pga.textContent = ans.data.station[id].pga.toFixed(2);
        current_station_intensity.className = `current-station-intensity intensity-${intensity_float_to_int(I)}`;
        current_station_intensity_text.textContent = I.toFixed(1);
      }

      if (alert && ans.data.station[id].alert) {
        const I = intensity_float_to_int(ans.data.station[id].I);
        if (I > 0)
          data_alert_list.push({ type: "Feature", geometry: { type: "Point", coordinates: [station_location.lon, station_location.lat] }, properties: { i: I } });
        else if (TREM.variable.data.eew)
          data_alert_0_list.push({ type: "Feature", geometry: { type: "Point", coordinates: [station_location.lon, station_location.lat] }, properties: {} });

        coordinates.push({ lon: station_location.lon, lat: station_location.lat });
      } else if (!eew_alert)
        data_list.push({ type: "Feature", geometry: { type: "Point", coordinates: [station_location.lon, station_location.lat] }, properties: { i: ans.data.station[id].i } });
    }
  }

  if (ans.data || (Date.now() - TREM.variable.cache.last_data_time) > TREM.constant.LAST_DATA_TIMEOUT_ERROR) {
    if (TREM.variable.map) {
      TREM.variable.map.getSource("rts").setData({ type: "FeatureCollection", features: data_list });
      TREM.variable.map.getSource("markers-geojson").setData({ type: "FeatureCollection", features: data_alert_list });
      TREM.variable.map.getSource("markers-geojson-0").setData({ type: "FeatureCollection", features: data_alert_0_list });
    }

    const box_list = getTopIntensities(
      updateIntensityHistory(ans.data?.int ?? [], ans.data?.time ?? 0),
    ).sort((a, b) => b.i - a.i)
      .map(loc => intensity_item(loc.i, loc.name));

    const alert = (!ans.data?.box) ? false : Object.keys(ans.data.box).length;

    rts_intensity_list.replaceChildren(...box_list);

    max_pga.textContent = `${pga.toFixed(2)} gal`;
    max_pga.className = `max-station-pga ${(!alert) ? "intensity-0" : `intensity-${calculator.pgaToIntensity(pga)}`}`;
    max_intensity.className = `max-station-intensity intensity-${ans.data?.int?.[0]?.i ?? 0}`;

    TREM.variable.cache.bounds.rts = coordinates;
  }
});

function updateIntensityHistory(newData, time) {
  const updatedCodes = new Set();

  for (const int of newData) {
    updatedCodes.add(int.code);

    if (!int_cache_list[int.code])
      int_cache_list[int.code] = {
        values     : [],
        lastUpdate : time,
      };

    int_cache_list[int.code].values.push(int.i);
    int_cache_list[int.code].lastUpdate = time;

    if (int_cache_list[int.code].values.length > 30)
      int_cache_list[int.code].values.shift();
  }

  const cutoff = time - 30000;
  Object.keys(int_cache_list).forEach(code => {
    if (int_cache_list[code].lastUpdate < cutoff)
      delete int_cache_list[code];
  });

  const maxIntensities = Object.entries(int_cache_list).map(([code, data]) => ({
    code : code,
    i    : Math.max(...data.values),
  }));

  return maxIntensities;
}

function getTopIntensities(intensities, maxCount = 6) {
  if (intensities.length <= maxCount)
    return intensities.map(loc => {
      const name = search_loc_name(loc.code);
      return {
        i    : loc.i,
        name : name ? `${name.city}${name.town}` : "",
      };
    });


  const cityGroups = new Map();
  intensities.forEach(loc => {
    const name = search_loc_name(loc.code);
    if (!name) return;

    const current = cityGroups.get(name.city);
    if (!current || loc.i > current.i)
      cityGroups.set(name.city, {
        i    : loc.i,
        name : name.city,
      });

  });

  return Array.from(cityGroups.values())
    .sort((a, b) => b.i - a.i)
    .slice(0, maxCount);
}

function intensity_item(i, loc) {
  const box = document.createElement("div");
  box.className = "rts-intensity-item";

  const intensity = document.createElement("div");
  intensity.className = `rts-intensity intensity-${i}`;

  const location = document.createElement("div");
  location.className = "rts-loc";
  location.textContent = loc;

  box.append(intensity, location);
  return box;
}