const TREM = require("../constant");

const { intensity_float_to_int } = require("../utils/utils");

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

  if (!TREM.variable.station) return;

  if (ans.data) {
    const alert = Object.keys(ans.data.box).length;

    for (const id of Object.keys(ans.data.station)) {
      const station_info = TREM.variable.station[id];
      if (!station_info) continue;
      const station_location = station_info.info.at(-1);

      if (alert && ans.data.station[id].alert) {
        const I = intensity_float_to_int(ans.data.station[id].I);
        if (I > 0)
          data_alert_list.push({ type: "Feature", geometry: { type: "Point", coordinates: [station_location.lon, station_location.lat] }, properties: { i: I } });
        else if (TREM.variable.data.eew)
          data_alert_0_list.push({ type: "Feature", geometry: { type: "Point", coordinates: [station_location.lon, station_location.lat] }, properties: {} });
      } else if (!TREM.variable.data.eew)
        data_list.push({ type: "Feature", geometry: { type: "Point", coordinates: [station_location.lon, station_location.lat] }, properties: { i: ans.data.station[id].i } });
    }
  }

  if (ans.data || (Date.now() - TREM.variable.cache.last_data_time) > TREM.constant.LAST_DATA_TIMEOUT_ERROR)
    if (TREM.variable.map) {
      TREM.variable.map.getSource("rts").setData({ type: "FeatureCollection", features: data_list });
      TREM.variable.map.getSource("markers-geojson").setData({ type: "FeatureCollection", features: data_alert_list });
      TREM.variable.map.getSource("markers-geojson-0").setData({ type: "FeatureCollection", features: data_alert_0_list });
    }
});