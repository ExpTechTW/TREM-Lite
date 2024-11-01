const TREM = require("../constant");

const EEWCalculator = require("../utils/eewCalculator");
const { intensity_float_to_int, search_loc_name } = require("../utils/utils");

const calculator = new EEWCalculator(require("../../../resource/data/time.json"));

const eewIntensityArea = {};
const alertedCities = new Set();

TREM.variable.events.on("EewRelease", (ans) => updateEewArea(ans));

TREM.variable.events.on("EewUpdate", (ans) => updateEewArea(ans));

TREM.variable.events.on("EewEnd", (ans) => {
  delete eewIntensityArea[ans.data.id];
  drawEewArea(ans, true);
});

function updateEewArea(ans) {
  if (!TREM.constant.SHOW_TREM_EEW && ans.data.author === "trem") return;

  eewIntensityArea[ans.data.id] = calculator.eewAreaPga(
    ans.data.eq.lat,
    ans.data.eq.lon,
    ans.data.eq.depth,
    ans.data.eq.mag,
  );

  drawEewArea(ans);
}

function drawEewArea(ans, end = false) {
  const eewArea = processIntensityAreas();
  const mergedArea = mergeEqArea(eewArea, ans.data.eq.area);

  const highIntensityAreas = {};
  const highIntensityCities = new Set();

  Object.entries(mergedArea).forEach(([code, intensity]) => {
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
      data : { city_alert_list: Array.from(highIntensityCities), new_city_alert_list: Array.from(newHighIntensityCities) },
    });
    newHighIntensityCities.forEach(city => alertedCities.add(city));
  }

  const mapStyle = generateMapStyle(mergedArea, end);
  TREM.variable.map.setPaintProperty("town", "fill-color", mapStyle);

  if (end) alertedCities.clear();

  return {
    highIntensityAreas,
    highIntensityCities    : Array.from(highIntensityCities),
    newHighIntensityCities : Array.from(newHighIntensityCities),
  };
}


function mergeEqArea(eewArea, eqArea) {
  const mergedArea = { ...eewArea };

  Object.entries(eqArea).forEach(([intensity, codes]) => {
    codes.forEach(code => {
      if (!mergedArea[code] || mergedArea[code] < intensity)
        mergedArea[code] = intensity;

    });
  });

  return mergedArea;
}

function processIntensityAreas() {
  const eewArea = {};

  Object.entries(eewIntensityArea).forEach(([_, intensity]) => {
    Object.entries(intensity).forEach(([name, value]) => {
      if (name !== "max_i") {
        const intensityValue = intensity_float_to_int(value.i);
        if (!eewArea[name] || eewArea[name] < intensityValue)
          eewArea[name] = intensityValue;

      }
    });
  });

  return eewArea;
}

function generateMapStyle(eewArea, end) {
  if (end) return TREM.constant.COLOR.MAP.TW_COUNTY_FILL;

  const matchExpression = ["match", ["get", "CODE"]];

  if (Object.keys(eewArea).length > 0)
    Object.entries(eewArea).forEach(([code, intensity]) => {
      matchExpression.push(parseInt(code));
      matchExpression.push(
        intensity
          ? TREM.constant.COLOR.INTENSITY[intensity]
          : TREM.constant.COLOR.MAP.TW_COUNTY_FILL,
      );
    });


  matchExpression.push("#3F4045");

  return matchExpression;
}