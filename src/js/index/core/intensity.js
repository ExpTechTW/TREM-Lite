const TREM = require("../constant");
const { generateMapStyle, convertIntensityToAreaFormat } = require("../utils/utils");
const generateReportBoxItems = require("./report");

TREM.variable.events.on("MapLoad", (map) => {
  map.addSource("intensity-markers-geojson", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

  map.addLayer({
    id     : "intensity-markers",
    type   : "symbol",
    source : "intensity-markers-geojson",
    layout : {
      "symbol-sort-key" : ["get", "i"],
      "symbol-z-order"  : "source",
      "icon-image"      : [
        "match",
        ["get", "i"],
        1, "intensity-square-1",
        2, "intensity-square-2",
        3, "intensity-square-3",
        4, "intensity-square-4",
        5, "intensity-square-5",
        6, "intensity-square-6",
        7, "intensity-square-7",
        8, "intensity-square-8",
        9, "intensity-square-9",
        "intensity-square-0",
      ],
      "icon-size": [
        "interpolate",
        ["linear"],
        ["zoom"],
        5, 0.3,
        10, 0.7,
      ],
      "icon-allow-overlap"    : true,
      "icon-ignore-placement" : true,
    },
  });
});

TREM.variable.events.on("IntensityRelease", (ans) => {
  const data_list = [];

  generateReportBoxItems(TREM.variable.data.report, TREM.variable.data.intensity ? { time: TREM.variable.data.intensity.id, intensity: TREM.variable.data.intensity.max } : null);

  const mapStyle = generateMapStyle(convertIntensityToAreaFormat(TREM.variable.data.intensity.area));
  TREM.variable.map.setPaintProperty("town", "fill-color", mapStyle);
  TREM.variable.map.setPaintProperty("rts-layer", "circle-opacity", 0.2);

  data_list.push({ type: "Feature", geometry: { type: "Point", coordinates: [122, 23] }, properties: { i: 3 } });
  TREM.variable.map.getSource("intensity-markers-geojson").setData({ type: "FeatureCollection", features: data_list });
});