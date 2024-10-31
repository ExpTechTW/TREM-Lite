const TREM = require("../constant");

TREM.variable.events.on("MapLoad", (map) => {
  map.addSource("rts", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

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

  map.addSource("markers-geojson", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

  map.addLayer({
    id     : "markers",
    type   : "symbol",
    source : "markers-geojson",
    layout : {
      "symbol-sort-key" : ["get", "intensity"],
      "symbol-z-order"  : "source",
      "icon-image"      : [
        "match",
        ["get", "intensity"],
        1, "intensity-1",
        2, "intensity-2",
        3, "intensity-3",
        4, "intensity-4",
        5, "intensity-5",
        6, "intensity-6",
        7, "intensity-7",
        8, "intensity-8",
        9, "intensity-9",
        10, "cross",
        "gps",
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

  map.getSource("markers-geojson").setData({
    type     : "FeatureCollection",
    features : [
      {
        type     : "Feature",
        geometry : {
          type        : "Point",
          coordinates : [121.5, 25.0],
        },
        properties: {
          intensity: 5,
        },
      },
    ],
  });
});

TREM.variable.events.on("DataRts", (ans) => {
  const data_list = [];

  if (!TREM.variable.station) return;

  for (const id of Object.keys(ans.data.station)) {
    const station_info = TREM.variable.station[id];
    if (!station_info) continue;
    const station_location = station_info.info.at(-1);
    data_list.push({
      type     : "Feature",
      geometry : {
        type        : "Point",
        coordinates : [station_location.lon, station_location.lat],
      },
      properties: {
        i: ans.data.station[id].i,
      },
    });
  }

  if (TREM.variable.map) TREM.variable.map.getSource("rts").setData({ type: "FeatureCollection", features: data_list });
});