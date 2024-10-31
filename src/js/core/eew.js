const TREM = require("../constant");

TREM.variable.events.on("MapLoad", (map) => {
  addEewCircle(map, {
    id     : "eew1",
    status : 1,
    eq     : {
      latitude  : 25.0,
      longitude : 121.5,
    },
  });
});

TREM.variable.events.on("DataEew", (ans) => {});

function addEewCircle(map, eew) {
  const center = [eew.eq.longitude, eew.eq.latitude];

  map.addSource(`${eew.id}-s-wave`, {
    type : "geojson",
    data : {
      type     : "FeatureCollection",
      features : [createCircleFeature(center, 100)],
    },
    tolerance : 0.5,
    buffer    : 128,
  });

  map.addSource(`${eew.id}-p-wave`, {
    type : "geojson",
    data : {
      type     : "FeatureCollection",
      features : [createCircleFeature(center, 150)],
    },
    tolerance : 0.5,
    buffer    : 128,
  });

  const color =
    eew.status == 1
      ? TREM.constant.COLOR.EEW.S.ALERT
      : TREM.constant.COLOR.EEW.S.WARN;

  map.addLayer({
    id     : `${eew.id}-s-wave-outline`,
    type   : "line",
    source : `${eew.id}-s-wave`,
    paint  : {
      "line-color" : color,
      "line-width" : 2,
    },
  });

  map.addLayer(
    {
      id     : `${eew.id}-s-wave-background`,
      type   : "fill",
      source : `${eew.id}-s-wave`,
      paint  : {
        "fill-color"   : color,
        "fill-opacity" : 0.25,
      },
    },
    "county",
  );

  map.addLayer({
    id     : `${eew.id}-p-wave-outline`,
    type   : "line",
    source : `${eew.id}-p-wave`,
    paint  : {
      "line-color" : TREM.constant.COLOR.EEW.P,
      "line-width" : 1,
    },
  });
}

function createCircleFeature(center, radius, steps = 256) {
  const coordinates = [[]];
  const km = radius;

  for (let i = 0; i <= steps; i++) {
    const angle = (i * 360) / steps;
    const rad = (angle * Math.PI) / 180;

    const δ = km / 6371;
    const φ1 = (center[1] * Math.PI) / 180;
    const λ1 = (center[0] * Math.PI) / 180;
    const θ = rad;

    const φ2 = Math.asin(
      Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ),
    );

    const λ2 =
      λ1 +
      Math.atan2(
        Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
        Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
      );

    const lat = (φ2 * 180) / Math.PI;
    const lng = (λ2 * 180) / Math.PI;

    coordinates[0].push([lng, lat]);
  }

  coordinates[0].push(coordinates[0][0]);

  return {
    type       : "Feature",
    properties : {},
    geometry   : {
      type        : "Polygon",
      coordinates : coordinates,
    },
  };
}
