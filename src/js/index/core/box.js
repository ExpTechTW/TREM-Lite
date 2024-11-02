const TREM = require("../constant");

const box_data = require("../../../resource/data/box.json");
const { distance } = require("../utils/utils");

function refresh_box(show) {
  const boxFeatures = [];

  if (TREM.constant.SHOW_TREM_EEW && show && TREM.variable.data.rts)
    for (const area of box_data.features) {
      const id = area.properties.ID;
      if (TREM.variable.data.rts?.box[id] !== undefined) {
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
            i: TREM.variable.data.rts.box[id],
          },
        });
      }
    }

  TREM.variable.map.getSource("box-geojson").setData({
    type     : "FeatureCollection",
    features : boxFeatures,
  });
}

function checkBoxSkip(eew, area) {
  let skip = 0;
  const coordinates = area.geometry.coordinates[0];
  for (let i = 0; i < 4; i++) {
    const dist = distance(eew.eq.lat, eew.eq.lon)(coordinates[i][1], coordinates[i][0]);
    if (eew.dist.s_dist > dist) skip++;
  }
  return skip >= 4;
}

module.exports = refresh_box;