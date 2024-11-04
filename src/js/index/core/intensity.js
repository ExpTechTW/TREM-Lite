const region = require("../../../resource/data/region.json");

const fetchData = require("../../core/utils/fetch");
const TREM = require("../constant");
const now = require("../utils/ntp");
const { generateMapStyle, convertIntensityToAreaFormat, int_to_string, search_loc_name } = require("../utils/utils");
const drawEewArea = require("./estimate");
const { focus_reset, focus } = require("./focus");
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
    },
  });

  setInterval(refresh_intensity, 10000);
  refresh_intensity();
});

TREM.variable.events.on("IntensityRelease", (ans) => {
  const data_list = [];
  const bounds = [];

  TREM.variable.cache.show_intensity = true;

  TREM.variable.cache.intensity.time = ans.data.id;
  TREM.variable.cache.intensity.max = ans.data.max;

  generateReportBoxItems(TREM.variable.data.report, TREM.variable.cache.intensity.time ? { time: TREM.variable.cache.intensity.time, intensity: TREM.variable.cache.intensity.max } : null);

  const city_intensity_list = findMaxIntensityCity(ans.data.area);

  const code_intensity = convertIntensityToAreaFormat(ans.data.area);

  const mapStyle = generateMapStyle(code_intensity);
  TREM.variable.map.setPaintProperty("town", "fill-color", mapStyle);
  TREM.variable.map.setPaintProperty("rts-layer", "circle-opacity", 0.2);

  for (const code of Object.keys(code_intensity)) {
    const loc = search_loc_name(code);
    const loc_info = region[loc.city][loc.town];
    bounds.push({ lon: loc_info.lon, lat: loc_info.lat });
    data_list.push({ type: "Feature", geometry: { type: "Point", coordinates: [loc_info.lon, loc_info.lat] }, properties: { i: 3 } });
  }

  TREM.variable.cache.bounds.intensity = bounds;

  TREM.variable.map.getSource("intensity-markers-geojson").setData({ type: "FeatureCollection", features: data_list });

  TREM.variable.speech.speak({ text: `震度速報，震度${int_to_string(city_intensity_list.intensity).replace("級", "")}，${city_intensity_list.cities.join("、")}`, queue: true });

  focus();

  setTimeout(() => {
    TREM.variable.cache.show_intensity = false;
    TREM.variable.events.emit("DataRts", {
      info: {
        type: TREM.variable.play_mode,
      },
      data: TREM.variable.data.rts,
    });
    TREM.variable.cache.bounds.intensity = [];
    focus_reset();
    TREM.variable.map.setPaintProperty("rts-layer", "circle-opacity", 1);
    TREM.variable.map.getSource("intensity-markers-geojson").setData({ type: "FeatureCollection", features: [] });
    drawEewArea();
  }, 5000);
});

function findMaxIntensityCity(eqArea) {
  if (!eqArea || Object.keys(eqArea).length === 0)
    return null;

  const maxIntensity = Math.max(...Object.keys(eqArea).map(Number));

  const maxIntensityCodes = eqArea[maxIntensity] || [];

  const citiesWithMaxIntensity = maxIntensityCodes
    .map(code => search_loc_name(parseInt(code)))
    .filter(location => location !== null)
    .map(location => location.city);

  const uniqueCities = [...new Set(citiesWithMaxIntensity)];

  return {
    intensity : maxIntensity,
    cities    : uniqueCities,
  };
}

async function get_intensity() {
  const url = TREM.constant.URL.API[1];
  const ans = await fetchData(`https://${url}/api/v1/trem/intensity`, TREM.constant.HTTP_TIMEOUT.REPORT);
  if (!ans.ok) return null;
  return await ans.json();
}

const d = { id: Date.now(), "alert": 0, "final": 0, "area": { "1": [260, 265, 270, 263, 264, 269, 268, 266] }, "max": 1 };

async function refresh_intensity() {
  const data = await get_intensity();
  if (!data) return;

  data.push(d);

  IntensityData(data);
}

function IntensityData(newData = []) {
  const currentTime = now();
  const EXPIRY_TIME = 240 * 1000;

  TREM.variable.data.intensity
    .filter(item =>
      item.id &&
      (currentTime - item.id > EXPIRY_TIME || item.IntensityEnd),
    )
    .forEach(data => {
      TREM.variable.events.emit("IntensityEnd", {
        info : { type: TREM.variable.play_mode },
        data : { ...data, IntensityEnd: true },
      });
    });

  TREM.variable.data.intensity = TREM.variable.data.intensity.filter(item =>
    item.id &&
    currentTime - item.id <= EXPIRY_TIME &&
    !item.IntensityEnd,
  );

  newData.forEach(data => {
    if (!data.id || currentTime - data.id > EXPIRY_TIME || data.IntensityEnd) return;

    const existingIndex = TREM.variable.data.intensity.findIndex(item => item.id == data.id);
    const eventData = {
      info: { type: TREM.variable.play_mode },
      data,
    };

    if (existingIndex == -1)
      if (!TREM.variable.cache.intensity_last[data.id]) {
        TREM.variable.cache.intensity_last[data.id] = {
          last_time : currentTime,
          serial    : 1,
        };
        TREM.variable.data.intensity.push(data);
        TREM.variable.events.emit("IntensityRelease", eventData);
        return;
      }

    if (TREM.variable.cache.intensity_last[data.id] && TREM.variable.cache.intensity_last[data.id].serial < data.serial) {
      TREM.variable.cache.intensity_last[data.id].serial = data.serial;
      TREM.variable.events.emit("IntensityUpdate", eventData);

      TREM.variable.data.intensity[existingIndex] = data;
    }
  });

  Object.keys(TREM.variable.cache.intensity_last).forEach(id => {
    const item = TREM.variable.cache.intensity_last[id];
    if (currentTime - item.last_time > 600000) delete TREM.variable.cache.intensity_last[id];
  });

  TREM.variable.events.emit("DataIntensity", {
    info : { type: TREM.variable.play_mode },
    data : TREM.variable.data.intensity,
  });
}