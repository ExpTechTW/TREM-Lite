const TREM = require("../constant");
const EEWCalculator = require("../utils/eewCalculator");
const now = require("../utils/ntp");
const { formatTime } = require("../utils/utils");
const refresh_cross = require("./cross");

const calculator = new EEWCalculator(require("../../../resource/data/time.json"));

const info_wrapper = document.getElementById("info-wrapper");
const info_unit = document.getElementById("info-unit");
const info_number = document.getElementById("info-number");
const info_loc = document.getElementById("info-loc");
const info_mag = document.getElementById("info-mag");
const info_depth = document.getElementById("info-depth");
const info_intensity = document.getElementById("info-intensity");
const info_footer = document.getElementById("info-footer");
const info_time = document.getElementById("info-time");

let flash = false;
let eew_rotation = 0;
const eew_cache = {};

TREM.variable.events.on("EewRelease", (ans) => {
  eew_cache[ans.data.id] = ans.data;
  show_eew(false);

  TREM.variable.map.addSource(`${ans.data.id}-s-wave`, { type: "geojson", data: { type: "FeatureCollection", features: [] }, tolerance: 1, buffer: 128 });
  TREM.variable.map.addSource(`${ans.data.id}-p-wave`, { type: "geojson", data: { type: "FeatureCollection", features: [] }, tolerance: 1, buffer: 128 });

  TREM.variable.map.addLayer({
    id     : `${ans.data.id}-p-wave-outline`,
    type   : "line",
    source : `${ans.data.id}-p-wave`,
    paint  : {
      "line-color" : TREM.constant.COLOR.EEW.P,
      "line-width" : (!TREM.constant.SHOW_TREM_EEW && ans.data.author == "trem") ? 0.2 : 1,
    },
  });

  const color = (!TREM.constant.SHOW_TREM_EEW && ans.data.author == "trem") ? TREM.constant.COLOR.TREM.S :
    ans.data.status == 1
      ? TREM.constant.COLOR.EEW.S.ALERT
      : TREM.constant.COLOR.EEW.S.WARN;

  TREM.variable.map.addLayer({
    id     : `${ans.data.id}-s-wave-outline`,
    type   : "line",
    source : `${ans.data.id}-s-wave`,
    paint  : {
      "line-color" : color,
      "line-width" : (!TREM.constant.SHOW_TREM_EEW && ans.data.author == "trem") ? 0.6 : 2,
    },
  });

  TREM.variable.map.addLayer(
    {
      id     : `${ans.data.id}-s-wave-background`,
      type   : "fill",
      source : `${ans.data.id}-s-wave`,
      paint  : {
        "fill-color"   : (!TREM.constant.SHOW_TREM_EEW && ans.data.author == "trem") ? TREM.constant.COLOR.TREM.P : color,
        "fill-opacity" : (!TREM.constant.SHOW_TREM_EEW && ans.data.author == "trem") ? 0 : 0.25,
      },
    },
    "county",
  );
});

TREM.variable.events.on("EewAlert", (ans) => {
  if (TREM.variable.map.getLayer(`${ans.data.id}-s-wave-outline`)) TREM.variable.map.removeLayer(`${ans.data.id}-s-wave-outline`);
  if (TREM.variable.map.getLayer(`${ans.data.id}-s-wave-background`)) TREM.variable.map.removeLayer(`${ans.data.id}-s-wave-background`);

  const color = (!TREM.constant.SHOW_TREM_EEW && ans.data.author == "trem") ? TREM.constant.COLOR.TREM.S :
    TREM.constant.COLOR.EEW.S.ALERT;

  TREM.variable.map.addLayer({
    id     : `${ans.data.id}-s-wave-outline`,
    type   : "line",
    source : `${ans.data.id}-s-wave`,
    paint  : {
      "line-color" : color,
      "line-width" : (!TREM.constant.SHOW_TREM_EEW && ans.data.author == "trem") ? 0.6 : 2,
    },
  });

  TREM.variable.map.addLayer(
    {
      id     : `${ans.data.id}-s-wave-background`,
      type   : "fill",
      source : `${ans.data.id}-s-wave`,
      paint  : {
        "fill-color"   : color,
        "fill-opacity" : (!TREM.constant.SHOW_TREM_EEW && ans.data.author == "trem") ? 0 : 0.25,
      },
    },
    "county",
  );
});

TREM.variable.events.on("EewUpdate", (ans) => {
  eew_cache[ans.data.id] = ans.data;
  show_eew(false);
  refresh_cross(false);
});
TREM.variable.events.on("EewEnd", (ans) => {
  removeEewLayersAndSources(ans.data.id);
  delete eew_cache[ans.data.id];
  show_eew(true);
});

setInterval(() => {
  for (const eew of TREM.variable.data.eew) {
    if (!TREM.constant.SHOW_TREM_EEW && eew.author == "trem") continue;
    if (eew.eq.mag == 1) continue;
    const sWaveSource = TREM.variable.map.getSource(`${eew.id}-s-wave`);
    const pWaveSource = TREM.variable.map.getSource(`${eew.id}-p-wave`);
    if (sWaveSource && pWaveSource) {
      const center = [eew.eq.lon, eew.eq.lat];
      const dist = calculator.psWaveDist(eew.eq.depth, eew.eq.time, now());
      eew.dist = dist;
      sWaveSource.setData({ type: "FeatureCollection", features: [createCircleFeature(center, dist.s_dist)] });
      pWaveSource.setData({ type: "FeatureCollection", features: [createCircleFeature(center, dist.p_dist)] });
    }
  }
}, 100);

if (!TREM.constant.SHOW_TREM_EEW)
  setInterval(() => {
    for (const eew of TREM.variable.data.eew) {
      if (!eew.author == "trem") continue;
      const sWaveSource = TREM.variable.map.getSource(`${eew.id}-s-wave`);
      const pWaveSource = TREM.variable.map.getSource(`${eew.id}-p-wave`);
      if (sWaveSource && pWaveSource) {
        const center = [eew.eq.lon, eew.eq.lat];
        const dist = calculator.psWaveDist(eew.eq.depth, eew.eq.time, now());
        if (flash) {
          sWaveSource.setData({ type: "FeatureCollection", features: [createCircleFeature(center, dist.s_dist)] });
          pWaveSource.setData({ type: "FeatureCollection", features: [createCircleFeature(center, dist.p_dist)] });
        } else {
          sWaveSource.setData({ type: "FeatureCollection", features: [] });
          pWaveSource.setData({ type: "FeatureCollection", features: [] });
        }
      }
    }

    flash = !flash;
  }, 500);

setInterval(show_eew, 5000);

function show_eew(rotation = true) {
  let count = 0;
  const eew_list = Object.keys(eew_cache);

  for (const eew of TREM.variable.data.eew) {
    if (!TREM.constant.SHOW_TREM_EEW && eew.author == "trem") continue;
    count++;
  }

  if (count) {
    if (eew_cache[eew_list[eew_rotation]]) {
      info_wrapper.className = `info-wrapper ${(eew_cache[eew_list[eew_rotation]].status == 1) ? "eew-alert" : "eew-warn"}`;
      info_number.textContent = eew_cache[eew_list[eew_rotation]].serial;
      if (eew_cache[eew_list[eew_rotation]].final) info_number.className = "info-number info-number-last";
      else info_number.className = "info-number";
      info_unit.textContent = `${eew_cache[eew_list[eew_rotation]].author.toUpperCase()}${(count == 1) ? "" : ` ${eew_rotation + 1}/${count}`}`;
      info_loc.textContent = eew_cache[eew_list[eew_rotation]].eq.loc;
      info_depth.textContent = eew_cache[eew_list[eew_rotation]].eq.depth;
      info_mag.textContent = eew_cache[eew_list[eew_rotation]].eq.mag.toFixed(1);
      info_intensity.className = `info-title-box intensity-${eew_cache[eew_list[eew_rotation]].eq.max}`;
      if (eew_cache[eew_list[eew_rotation]].eq.mag == 1) info_footer.className = "info-footer nsspe";
      else info_footer.className = "info-footer";
      info_time.textContent = formatTime(eew_cache[eew_list[eew_rotation]].eq.time);
    }

    if (rotation) {
      eew_rotation++;
      if (eew_rotation >= eew_list.length) eew_rotation = 0;
    }
  } else {
    info_wrapper.className = "info-wrapper no-eew";
    info_number.textContent = "";
    info_number.className = "info-number";
    info_unit.textContent = "";
  }
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

function removeEewLayersAndSources(eewId) {
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