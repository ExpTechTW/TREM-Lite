const TREM = require("../constant");

const EEWCalculator = require("../utils/eewCalculator");
const { intensity_float_to_int, search_loc_name, generateMapStyle, convertIntensityToAreaFormat } = require("../utils/utils");

const calculator = new EEWCalculator(require("../../../resource/data/time.json"));

const alertedCities = new Set();

TREM.variable.events.on("EewRelease", (ans) => updateEewArea(ans));

TREM.variable.events.on("EewUpdate", (ans) => updateEewArea(ans));

TREM.variable.events.on("EewEnd", (ans) => {
  delete TREM.variable.cache.eewIntensityArea[ans.data.id];
  drawEewArea(true);
});

function updateEewArea(ans) {
  if (!TREM.constant.SHOW_TREM_EEW && ans.data.author === "trem") return;

  const area = calculator.eewAreaPga(
    ans.data.eq.lat,
    ans.data.eq.lon,
    ans.data.eq.depth,
    ans.data.eq.mag,
  );

  const mergedArea = mergeEqArea(area, ans.data.eq.area ?? {});

  TREM.variable.cache.eewIntensityArea[ans.data.id] = mergedArea;

  drawEewArea();
}

function drawEewArea(end = false) {
  if (TREM.variable.cache.show_intensity) return;

  if (!Object.keys(TREM.variable.cache.eewIntensityArea).length) {
    TREM.variable.map.setPaintProperty("town", "fill-color", TREM.constant.COLOR.MAP.TW_TOWN_FILL);
    return;
  }

  const eewArea = processIntensityAreas();

  const highIntensityAreas = {};
  const highIntensityCities = new Set();

  Object.entries(eewArea).forEach(([code, intensity]) => {
    if (intensity >= 5) {
      highIntensityAreas[code] = intensity;
      const location = search_loc_name(parseInt(code));
      if (location) highIntensityCities.add(location.city);
    }
  });

  const newHighIntensityCities = new Set(
    [...highIntensityCities].filter(city => !alertedCities.has(city)),
  );

  if (newHighIntensityCities.size > 0) {
    TREM.variable.events.emit("EewNewAreaAlert", {
      info : {},
      data : {
        city_alert_list     : Array.from(highIntensityCities),
        new_city_alert_list : Array.from(newHighIntensityCities),
      },
    });
    newHighIntensityCities.forEach(city => alertedCities.add(city));
  }

  const mapStyle = generateMapStyle(eewArea, end);
  TREM.variable.map.setPaintProperty("town", "fill-color", mapStyle);

  if (end) alertedCities.clear();

  return {
    highIntensityAreas,
    highIntensityCities    : Array.from(highIntensityCities),
    newHighIntensityCities : Array.from(newHighIntensityCities),
  };
}

function mergeEqArea(eewArea, eqArea) {
  const mergedArea = {};

  Object.entries(eewArea).forEach(([code, data]) => {
    if (code !== "max_i")
      mergedArea[code] = {
        I    : intensity_float_to_int(data.i),
        i    : data.i,
        dist : data.dist,
      };
  });

  Object.entries(eqArea).forEach(([intensity, codes]) => {
    const intensityFloat = parseFloat(intensity);
    codes.forEach(code => {
      if (mergedArea[code].I < intensityFloat)
        mergedArea[code].I = intensityFloat;
    });
  });

  let maxI = 0;
  Object.values(mergedArea).forEach(data => {
    if (data.I > maxI) maxI = data.I;
  });
  mergedArea.max_i = maxI;

  return mergedArea;
}

function processIntensityAreas() {
  const eewArea = {};

  Object.entries(TREM.variable.cache.eewIntensityArea).forEach(([_, intensity]) => {
    Object.entries(intensity).forEach(([name, value]) => {
      if (name !== "max_i")
        if (!eewArea[name] || eewArea[name] < value.I)
          eewArea[name] = value.I;
    });
  });

  return eewArea;
}

module.exports = drawEewArea;