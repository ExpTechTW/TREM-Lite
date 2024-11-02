const TREM = require("../constant");

function refresh_cross(show) {
  const markerFeatures = [];
  const eew_list = [];

  if (show) {
    for (const eew of TREM.variable.data.eew) {
      if (!TREM.constant.SHOW_TREM_EEW && eew.author == "trem") continue;
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

        if (no < 5)
          markerFeatures.push({
            type     : "Feature",
            geometry : {
              type        : "Point",
              coordinates : [eew.eq.lon, eew.eq.lat],
            },
            properties: {
              no,
              markerType   : eew.eq.mag === 1 ? "dot" : "cross",
              maxIntensity : eew.eq.max,
              fillColor    : TREM.constant.COLOR.INTENSITY[eew.eq.max],
              strokeColor  : TREM.constant.COLOR.INTENSITY_TEXT[eew.eq.max],
            },
          });
      }
    }
  }

  TREM.variable.map.getSource("cross-geojson").setData({
    type     : "FeatureCollection",
    features : markerFeatures,
  });

  if (!TREM.variable.map.getLayer("dots"))
    TREM.variable.map.addLayer({
      id     : "dots",
      type   : "circle",
      source : "cross-geojson",
      filter : ["==", ["get", "markerType"], "dot"],
      paint  : {
        "circle-radius"       : 10,
        "circle-color"        : ["get", "fillColor"],
        "circle-stroke-width" : 4,
        "circle-stroke-color" : ["get", "strokeColor"],
      },
    });

  TREM.variable.map.moveLayer("cross");
  TREM.variable.map.moveLayer("dots");
}

module.exports = refresh_cross;