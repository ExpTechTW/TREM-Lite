const TREM = require("../constant");

const EEWCalculator = require("../utils/eewCalculator");
const { intensity_float_to_int } = require("../utils/utils");

const calculator = new EEWCalculator(require("../../resource/data/time.json"));

const eewIntensityArea = {};

TREM.variable.events.on("EewRelease", (ans) => updateEewArea(ans));

TREM.variable.events.on("EewUpdate", (ans) => updateEewArea(ans));

TREM.variable.events.on("EewEnd", (ans) => {
  delete eewIntensityArea[ans.data.id];
  drawEewArea(true);
});

function updateEewArea(ans) {
  eewIntensityArea[ans.data.id] =
    calculator.eewAreaPga(ans.data.eq.lat, ans.data.eq.lon, ans.data.eq.depth, ans.data.eq.mag);
  drawEewArea();
}

function drawEewArea(end = false) {
  const eewArea = {};

  Object.entries(eewIntensityArea).forEach(([key, intensity]) => {
    Object.entries(intensity).forEach(([name, value]) => {
      if (name !== "max_i") {
        const intensityValue = intensity_float_to_int(value.i);
        if (!eewArea[name] || eewArea[name] < intensityValue)
          eewArea[name] = intensityValue;
      }
    });
  });

  const matchExpression = [
    "match",
    ["get", "CODE"],
  ];

  if (Object.keys(eewArea).length > 0)
    Object.entries(eewArea).forEach(([code, intensity]) => {
      matchExpression.push(parseInt(code));
      if (intensity) matchExpression.push(TREM.constant.COLOR.INTENSITY[intensity]);
      else matchExpression.push(TREM.constant.COLOR.MAP.TW_COUNTY_FILL);
    });

  matchExpression.push("#3F4045");

  TREM.variable.map.setPaintProperty(
    "town",
    "fill-color",
    (end) ? TREM.constant.COLOR.MAP.TW_COUNTY_FILL : matchExpression,
  );
}