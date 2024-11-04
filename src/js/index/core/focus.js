const TREM = require("../constant");

const maplibregl = require("maplibre-gl");

const focus_button = document.getElementById("focus");

let lock = false;

setInterval(focus, 3000);

TREM.variable.events.on("EewRelease", focus);

TREM.variable.events.on("EewUpdate", focus);

TREM.variable.events.on("EewEnd", focus);

let isMouseDown = false;

TREM.variable.events.on("MapLoad", (map) => {
  TREM.variable.map.on("mousedown", (e) => {
    isMouseDown = true;
  });

  TREM.variable.map.on("mouseup", (e) => {
    isMouseDown = false;
  });

  TREM.variable.map.on("movestart", (e) => {
    if (isMouseDown) {
      lock = true;
      focus_button.style.color = "red";
    }
  });
});

focus_button.addEventListener("click", () => {
  focus_reset();

  lock = false;
  focus_button.style.color = "white";
});

function focus() {
  if (lock) return;

  if (TREM.variable.cache.bounds.intensity.length) {
    updateMapBounds(TREM.variable.cache.bounds.intensity);
    return;
  }

  const eew_bounds = [];
  for (const eew of TREM.variable.data.eew)
    eew_bounds.push({ lon: eew.eq.lon, lat: eew.eq.lat });

  const bounds = [...TREM.variable.cache.bounds.rts, ...eew_bounds];

  if (bounds.length) updateMapBounds(bounds);
}

function focus_reset() {
  TREM.variable.map.fitBounds(TREM.constant.MAP.BOUNDS, TREM.constant.MAP.OPTIONS);
}

function updateMapBounds(coordinates, options = {}) {
  const bounds = new maplibregl.LngLatBounds();

  coordinates.forEach(coord => {
    bounds.extend([coord.lon, coord.lat]);
  });

  TREM.variable.map.fitBounds(bounds, {
    padding: {
      top    : options.paddingTop || 150,
      bottom : options.paddingBottom || 150,
      left   : options.paddingLeft || 150,
      right  : options.paddingRight || 150,
    },
    maxZoom  : options.maxZoom || 8,
    duration : options.duration || 500,
  });
}

module.exports = { focus, focus_reset };