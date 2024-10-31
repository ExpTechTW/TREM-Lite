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
          "background-color": "#1f2025",
        },
      },
      {
        id             : "county",
        type           : "fill",
        source         : "map",
        "source-layer" : "city",
        paint          : {
          "fill-color"   : "#3F4045",
          "fill-opacity" : 1,
        },
      },
      {
        id             : "town",
        type           : "fill",
        source         : "map",
        "source-layer" : "town",
        paint          : {
          "fill-color"   : "#3F4045",
          "fill-opacity" : 1,
        },
      },
      {
        id             : "county-outline",
        source         : "map",
        "source-layer" : "city",
        type           : "line",
        paint          : {
          "line-color": "#a9b4bc",
        },
      },
      {
        id             : "global",
        type           : "fill",
        source         : "map",
        "source-layer" : "global",
        paint          : {
          "fill-color"   : "#3f4045",
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
  for (const i of intensityIcons) {
    const image = await map.loadImage(`../resource/image/intensity-${i}-dark.png`);
    map.addImage(`intensity-${i}`, image.data);
  }

  const gpsImage = await map.loadImage("../resource/image/gps.png");
  map.addImage("gps", gpsImage.data);

  const crossImage = await map.loadImage("../resource/image/cross.png");
  map.addImage("cross", crossImage.data);

  TREM.variable.map = map;
  TREM.variable.events.emit("MapLoad", map);
});