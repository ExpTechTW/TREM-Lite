const TREM = require("../constant");
const box_data = require("../../../resource/data/box.json");
const { distance } = require("../utils/utils");

function checkBoxSkip(eew, area) {
  let skip = 0;
  const coordinates = area.geometry.coordinates[0];
  for (let i = 0; i < 4; i++) {
    const dist = distance(eew.eq.lat, eew.eq.lon)(coordinates[i][1], coordinates[i][0]);
    if (eew.dist.s_dist > dist) skip++;
  }
  return skip >= 4;
}

function refresh_box(show) {
  const boxFeatures = [];
  const emptyData = {
    type     : "FeatureCollection",
    features : boxFeatures,
  };

  if (!Object.keys(TREM.variable.data.rts?.box).length) return;

  const trem_alert = TREM.variable.data.eew.some(eew => eew.author === "trem");
  if (!TREM.constant.SHOW_TREM_EEW && trem_alert) {
    TREM.variable.map.getSource("box-geojson").setData(emptyData);
    return;
  }

  if (show && TREM.variable.data.rts)
    for (const area of box_data.features) {
      const id = area.properties.ID;
      const boxIntensity = TREM.variable.data.rts?.box[id];
      if (boxIntensity === undefined) continue;
      let shouldSkip = false;
      for (const eew of TREM.variable.data.eew) {
        if (!eew.dist) continue;
        if (checkBoxSkip(eew, area)) {
          shouldSkip = true;
          break;
        }
      }
      if (shouldSkip) continue;
      boxFeatures.push({
        type     : "Feature",
        geometry : {
          type        : "Polygon",
          coordinates : [area.geometry.coordinates[0]],
        },
        properties: {
          i: boxIntensity,
        },
      });
    }

  TREM.variable.map.getSource("box-geojson").setData({
    type     : "FeatureCollection",
    features : boxFeatures,
  });
}

module.exports = refresh_box;