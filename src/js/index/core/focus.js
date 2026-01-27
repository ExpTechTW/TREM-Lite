const TREM = require('../constant');
const maplibregl = require('maplibre-gl');
const Config = require('../../core/config');

class FocusManager {
  static instance = null;

  constructor() {
    if (FocusManager.instance) {
      return FocusManager.instance;
    }
    this.lock = false;
    this.isMouseDown = false;
    this.config = Config.getInstance().getConfig();
    this.focusInterval = null;
    this.mapInitialized = false;

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
    if (this.focusInterval) {
      clearInterval(this.focusInterval);
    }
    this.focusInterval = setInterval(() => this.focus(), 3000);
  }

  bindEvents() {
    this.focusButton.addEventListener('click', () => {
      this.focusReset(true);
      this.lock = false;
      this.isMouseDown = false;
      this.focusButton.style.color = 'white';
    });

    TREM.variable.events.on('EewRelease', () => this.focus());
    TREM.variable.events.on('EewUpdate', () => this.focus());
    TREM.variable.events.on('EewEnd', () => this.focus());
    TREM.variable.events.on('MapLoad', (map) => this.onMapLoad(map));
  }

  onMapLoad() {
    if (this.mapInitialized) {
      return;
    }
    this.mapInitialized = true;

    TREM.variable.map.on('mousedown', () => {
      this.isMouseDown = true;
      this.lock = true;
      this.focusButton.style.color = 'red';
    });

    TREM.variable.map.on('mouseup', () => {
      this.isMouseDown = false;
    });

    TREM.variable.map.on('wheel', () => {
      this.lock = true;
      this.focusButton.style.color = 'red';
    });
  }

  mouseDown() {
    return this.isMouseDown;
  }

  getLock() {
    return this.lock;
  }

  focus() {
    if (this.config['check-box']['graphics-block-auto-zoom']) {
      return;
    }
    if (this.lock) {
      return;
    }

    if (TREM.variable.cache.bounds.lpgm.length) {
      this.updateMapBounds(TREM.variable.cache.bounds.lpgm);
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
    else if (!TREM.variable.cache.bounds.report.length) {
      this.focusReset();
    }
  }

  focusReset(isBtn) {
    if (this.config['check-box']['graphics-block-auto-zoom'] && !isBtn) {
      return;
    }

    TREM.variable.map?.fitBounds(
      TREM.constant.MAP.BOUNDS,
      TREM.constant.MAP.OPTIONS,
    );
  }

  updateMapBounds(coordinates, options = {}) {
    const bounds = new maplibregl.LngLatBounds();

    coordinates.forEach((coord) => {
      bounds.extend([coord.lon, coord.lat]);
    });

    TREM.variable.map?.fitBounds(bounds, {
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
