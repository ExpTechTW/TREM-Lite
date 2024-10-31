const TREM = require("../constant");

const maplibregl = require("maplibre-gl");

const focus_button = document.getElementById("focus");

let lock = false;

setInterval(focus, 3000);

TREM.variable.events.on("EewRelease", focus);

TREM.variable.events.on("EewUpdate", focus);

TREM.variable.events.on("EewEnd", focus);

TREM.variable.events.on("MapLoad", (map) => {
  TREM.variable.map.on("click", (e) => {
    lock = true;
    focus_button.style.color = "red";
  });
  TREM.variable.map.on("movestart", (e) => {
    lock = true;
    focus_button.style.color = "red";
  });
  TREM.variable.map.on("contextmenu", (e) => {
    lock = false;
    focus_button.style.color = "white";
  });
});

focus_button.addEventListener("click", () => {
  TREM.variable.map.flyTo({ center: [121.6, 23.5], zoom: 6.8, duration: 0 });
  setTimeout(() => {
    lock = false;
    focus_button.style.color = "white";
  }, 100);
});

function focus() {
  if (lock) return;
  if (TREM.variable.cache.bounds.rts.length) updateMapBounds(TREM.variable.cache.bounds.rts);
  else TREM.variable.map.flyTo({ center: [121.6, 23.5], zoom: 6.8, duration: 500 });
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
    maxZoom  : options.maxZoom || 8.5,
    duration : options.duration || 500,
  });
}