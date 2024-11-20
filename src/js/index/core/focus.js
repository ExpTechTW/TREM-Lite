const TREM = require('../constant');
const maplibregl = require('maplibre-gl');

class FocusManager {
  static instance = null;

  constructor() {
    if (FocusManager.instance) {
      return FocusManager.instance;
    }
    this.lock = false;
    this.isMouseDown = false;
    this.focusButton = document.getElementById('focus');
    this.initialize();
    this.bindEvents();
    FocusManager.instance = this;
  }

  static getInstance() {
    if (!FocusManager.instance) {
      new FocusManager();
    }
    return FocusManager.instance;
  }

  initialize() {
    setInterval(() => this.focus(), 3000);
  }

  bindEvents() {
    this.focusButton.addEventListener('click', () => {
      this.focusReset();
      this.lock = false;
      this.focusButton.style.color = 'white';
    });

    TREM.variable.events.on('EewRelease', () => this.focus());
    TREM.variable.events.on('EewUpdate', () => this.focus());
    TREM.variable.events.on('EewEnd', () => this.focus());
    TREM.variable.events.on('MapLoad', () => this.onMapLoad());
  }

  onMapLoad() {
    TREM.variable.map.on('mousedown', () => {
      this.isMouseDown = true;
    });

    TREM.variable.map.on('mouseup', () => {
      this.isMouseDown = false;
    });

    TREM.variable.map.on('movestart', () => {
      if (this.isMouseDown) {
        this.lock = true;
        this.focusButton.style.color = 'red';
      }
    });
  }

  focus() {
    if (this.lock) {
      return;
    }

    if (TREM.variable.cache.bounds.intensity.length) {
      this.updateMapBounds(TREM.variable.cache.bounds.intensity);
      return;
    }

    const eewBounds = [];
    for (const eew of TREM.variable.data.eew) {
      eewBounds.push({ lon: eew.eq.lon, lat: eew.eq.lat });
    }

    const bounds = [...TREM.variable.cache.bounds.rts, ...eewBounds];

    if (bounds.length) {
      this.updateMapBounds(bounds);
    }
  }

  focusReset() {
    TREM.variable.map.fitBounds(
      TREM.constant.MAP.BOUNDS,
      TREM.constant.MAP.OPTIONS,
    );
  }

  updateMapBounds(coordinates, options = {}) {
    const bounds = new maplibregl.LngLatBounds();

    coordinates.forEach((coord) => {
      bounds.extend([coord.lon, coord.lat]);
    });

    TREM.variable.map.fitBounds(bounds, {
      padding: {
        top: options.paddingTop || 150,
        bottom: options.paddingBottom || 150,
        left: options.paddingLeft || 150,
        right: options.paddingRight || 150,
      },
      maxZoom: options.maxZoom || 8,
      duration: options.duration || 500,
    });
  }
}

TREM.class.FocusManager = FocusManager;

const focusManager = FocusManager.getInstance();

module.exports = {
  focus: (...args) => focusManager.focus(...args),
  focus_reset: (...args) => focusManager.focusReset(...args),
  updateMapBounds: (...args) => focusManager.updateMapBounds(...args),
};
