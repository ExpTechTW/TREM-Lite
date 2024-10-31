const TREM = require("../constant");

function refresh_cross(show) {
  const cross_list = [];
  const eew_list = [];

  if (show) {
    for (const eew of TREM.variable.data.eew) {
      const sWaveSource = TREM.variable.map.getSource(`${eew.id}-s-wave`);
      const pWaveSource = TREM.variable.map.getSource(`${eew.id}-p-wave`);
      if (sWaveSource && pWaveSource) eew_list.push(eew);
    }

    for (const eew of eew_list) {
      const sWaveSource = TREM.variable.map.getSource(`${eew.id}-s-wave`);
      const pWaveSource = TREM.variable.map.getSource(`${eew.id}-p-wave`);
      if (sWaveSource && pWaveSource) {
        const existingIndex = eew_list.findIndex(item => item.id === eew.id);
        let no = existingIndex;
        if (eew_list.length > 1) no++;
        if (no < 5) cross_list.push({ type: "Feature", geometry: { type: "Point", coordinates: [eew.eq.lon, eew.eq.lat] }, properties: { no } });
      }
    }
  }

  TREM.variable.map.getSource("cross-geojson").setData({ type: "FeatureCollection", features: cross_list });
  TREM.variable.map.moveLayer("cross");
}


module.exports = refresh_cross;