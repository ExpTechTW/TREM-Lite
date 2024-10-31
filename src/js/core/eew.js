const TREM = require("../constant");
const EEWCalculator = require("../utils/eewCalculator");
const now = require("../utils/ntp");
const refresh_cross = require("./cross");

const calculator = new EEWCalculator(require("../../resource/data/time.json"));

TREM.variable.events.on("EewRelease", (ans) => {
  if (!TREM.constant.EEW_AUTHOR.includes(ans.data.author)) return;

  TREM.variable.map.addSource(`${ans.data.id}-s-wave`, { type: "geojson", data: { type: "FeatureCollection", features: [] }, tolerance: 1, buffer: 128 });
  TREM.variable.map.addSource(`${ans.data.id}-p-wave`, { type: "geojson", data: { type: "FeatureCollection", features: [] }, tolerance: 1, buffer: 128 });

  TREM.variable.map.addLayer({
    id     : `${ans.data.id}-p-wave-outline`,
    type   : "line",
    source : `${ans.data.id}-p-wave`,
    paint  : {
      "line-color" : TREM.constant.COLOR.EEW.P,
      "line-width" : 1,
    },
  });

  const color =
  ans.data.status == 1
    ? TREM.constant.COLOR.EEW.S.ALERT
    : TREM.constant.COLOR.EEW.S.WARN;

  TREM.variable.map.addLayer({
    id     : `${ans.data.id}-s-wave-outline`,
    type   : "line",
    source : `${ans.data.id}-s-wave`,
    paint  : {
      "line-color" : color,
      "line-width" : 2,
    },
  });

  TREM.variable.map.addLayer(
    {
      id     : `${ans.data.id}-s-wave-background`,
      type   : "fill",
      source : `${ans.data.id}-s-wave`,
      paint  : {
        "fill-color"   : color,
        "fill-opacity" : 0.25,
      },
    },
    "county",
  );
});

TREM.variable.events.on("EewAlert", (ans) => {
  TREM.variable.map.removeLayer(`${ans.data.id}-s-wave-outline`);
  TREM.variable.map.removeLayer(`${ans.data.id}-s-wave-background`);

  const color =
  ans.data.status == 1
    ? TREM.constant.COLOR.EEW.S.ALERT
    : TREM.constant.COLOR.EEW.S.WARN;

  TREM.variable.map.addLayer({
    id     : `${ans.data.id}-s-wave-outline`,
    type   : "line",
    source : `${ans.data.id}-s-wave`,
    paint  : {
      "line-color" : color,
      "line-width" : 2,
    },
  });

  TREM.variable.map.addLayer(
    {
      id     : `${ans.data.id}-s-wave-background`,
      type   : "fill",
      source : `${ans.data.id}-s-wave`,
      paint  : {
        "fill-color"   : color,
        "fill-opacity" : 0.25,
      },
    },
    "county",
  );
});

TREM.variable.events.on("EewUpdate", (ans) => refresh_cross(true));
TREM.variable.events.on("EewEnd", (ans) => removeEewLayersAndSources(ans.data.id));

setInterval(() => {
  for (const eew of TREM.variable.data.eew) {
    const sWaveSource = TREM.variable.map.getSource(`${eew.id}-s-wave`);
    const pWaveSource = TREM.variable.map.getSource(`${eew.id}-p-wave`);
    if (sWaveSource && pWaveSource) {
      const center = [eew.eq.lon, eew.eq.lat];
      const dist = calculator.psWaveDist(eew.eq.depth, eew.eq.time, now());
      sWaveSource.setData({ type: "FeatureCollection", features: [createCircleFeature(center, dist.s_dist)] });
      pWaveSource.setData({ type: "FeatureCollection", features: [createCircleFeature(center, dist.p_dist)] });
    }
  }
}, 100);

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

function removeEewLayersAndSources(eewId) {
  if (!TREM.variable.map || !eewId) return;

  const layerIds = [
    `${eewId}-p-wave-outline`,
    `${eewId}-s-wave-outline`,
    `${eewId}-s-wave-background`,
  ];

  const sourceIds = [
    `${eewId}-s-wave`,
    `${eewId}-p-wave`,
  ];

  layerIds.forEach(layerId => {
    if (TREM.variable.map.getLayer(layerId))
      TREM.variable.map.removeLayer(layerId);

  });

  sourceIds.forEach(sourceId => {
    if (TREM.variable.map.getSource(sourceId))
      TREM.variable.map.removeSource(sourceId);
  });
}