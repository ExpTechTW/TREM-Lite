const maplibregl = require("maplibre-gl");

const TREM = require("../js/constant");

const intensityIcons = [1, 2, 3, 4, 5, 6, 7, 8, 9];

const map = new maplibregl.Map({
  container : "map",
  style     : {
    version : 8,
    name    : "ExpTech Studio",
    center  : [120.85, 23.10],
    zoom    : 6.2,
    sources : {
      map: {
        type     : "vector",
        url      : "https://api-1.exptech.dev/api/v1/map/tiles/tiles.json",
        tileSize : 512,
        buffer   : 64,
      },
    },
    sprite : "",
    glyphs : "https://glyphs.geolonia.com/{fontstack}/{range}.pbf",
    layers : [
      {
        id    : "background",
        type  : "background",
        paint : {
          "background-color": TREM.constant.COLOR.MAP.BACKGROUND,
        },
      },
      {
        id             : "county",
        type           : "fill",
        source         : "map",
        "source-layer" : "city",
        paint          : {
          "fill-color"   : TREM.constant.COLOR.MAP.TW_COUNTY_FILL,
          "fill-opacity" : 1,
        },
      },
      {
        id             : "town",
        type           : "fill",
        source         : "map",
        "source-layer" : "town",
        paint          : {
          "fill-color"   : TREM.constant.COLOR.MAP.TW_TOWN_FILL,
          "fill-opacity" : 1,
        },
      },
      {
        id             : "county-outline",
        source         : "map",
        "source-layer" : "city",
        type           : "line",
        paint          : {
          "line-color": TREM.constant.COLOR.MAP.TW_COUNTY_OUTLINE,
        },
      },
      {
        id             : "global",
        type           : "fill",
        source         : "map",
        "source-layer" : "global",
        paint          : {
          "fill-color"   : TREM.constant.COLOR.MAP.GLOBAL_FILL,
          "fill-opacity" : 1,
        },
      },
      {
        id             : "tsunami",
        type           : "line",
        source         : "map",
        "source-layer" : "tsunami",
        paint          : {
          "line-opacity" : 0,
          "line-width"   : 3,
        },
      },
    ],
  },
  center             : [121.6, 23.5],
  zoom               : 6.8,
  attributionControl : false,
});

map.on("load", async () => {
  for (const i of intensityIcons)
    map.addImage(`intensity-${i}`, (await map.loadImage(`../resource/image/intensity-${i}-dark.png`)).data);

  map.addImage("gps", (await map.loadImage("../resource/image/gps.png")).data);

  map.addImage("cross", (await map.loadImage("../resource/image/cross.png")).data);

  map.addImage("cross1", (await map.loadImage("../resource/image/cross1.png")).data);
  map.addImage("cross2", (await map.loadImage("../resource/image/cross2.png")).data);
  map.addImage("cross3", (await map.loadImage("../resource/image/cross3.png")).data);
  map.addImage("cross4", (await map.loadImage("../resource/image/cross4.png")).data);

  map.addSource("cross-geojson", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("markers-geojson", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("markers-geojson-0", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("rts", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

  map.addLayer({
    id     : "cross",
    type   : "symbol",
    source : "cross-geojson",
    layout : {
      "symbol-sort-key" : ["get", "no"],
      "symbol-z-order"  : "source",
      "icon-image"      : [
        "match",
        ["get", "no"],
        1, "cross1",
        2, "cross2",
        3, "cross3",
        4, "cross4",
        "cross",
      ],
      "icon-size": [
        "interpolate",
        ["linear"],
        ["zoom"],
        5, 0.02,
        10, 0.1,
      ],
      "icon-allow-overlap"    : true,
      "icon-ignore-placement" : true,
    },
  });

  TREM.variable.map = map;
  TREM.variable.events.emit("MapLoad", map);
});