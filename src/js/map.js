const maplibregl = require("maplibre-gl");

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
          "background-color": "#ffffff",
        },
      },
      {
        id             : "county",
        type           : "fill",
        source         : "map",
        "source-layer" : "city",
        paint          : {
          "fill-color"   : "#e3e3e3",
          "fill-opacity" : 1,
        },
      },
      {
        id             : "town",
        type           : "fill",
        source         : "map",
        "source-layer" : "town",
        paint          : {
          "fill-color"   : "#e3e3e3",
          "fill-opacity" : 1,
        },
      },
      {
        id             : "county-outline",
        source         : "map",
        "source-layer" : "city",
        type           : "line",
        paint          : {
          "line-color": "#79747e",
        },
      },
      {
        id             : "global",
        type           : "fill",
        source         : "map",
        "source-layer" : "global",
        paint          : {
          "fill-color"   : "#f3f3f3",
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
  center : [120.85, 23.10],
  zoom   : 6.2,
});