const maplibregl = require("maplibre-gl");

const TREM = require("./constant");

const intensityIcons = [1, 2, 3, 4, 5, 6, 7, 8, 9];

const map = new maplibregl.Map({
  container : "map",
  style     : {
    version : 8,
    name    : "ExpTech Studio",
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
  pitchWithRotate    : false,
  dragRotate         : false,
});

map.on("resize", () => map.fitBounds(TREM.constant.MAP.BOUNDS, TREM.constant.MAP.OPTIONS));

map.on("load", async () => {
  map.resize();
  map.fitBounds(TREM.constant.MAP.BOUNDS, TREM.constant.MAP.OPTIONS);

  for (const i of intensityIcons)
    map.addImage(`intensity-${i}`, (await map.loadImage(`../resource/image/intensity-${i}-dark.png`)).data);

  map.addImage("gps", (await map.loadImage("../resource/image/gps.png")).data);
  map.addImage("cross", (await map.loadImage("../resource/image/cross.png")).data);
  map.addImage("cross1", (await map.loadImage("../resource/image/cross1.png")).data);
  map.addImage("cross2", (await map.loadImage("../resource/image/cross2.png")).data);
  map.addImage("cross3", (await map.loadImage("../resource/image/cross3.png")).data);
  map.addImage("cross4", (await map.loadImage("../resource/image/cross4.png")).data);

  TREM.variable.map = map;
  TREM.variable.events.emit("MapLoad", map);
});