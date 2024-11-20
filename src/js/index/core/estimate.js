const TREM = require('../constant');
const EEWCalculator = require('../utils/eewCalculator');
const { intensity_float_to_int, search_loc_name, generateMapStyle } = require('../utils/utils');

class EewAreaManager {
  static instance = null;

  constructor() {
    if (EewAreaManager.instance) {
      return EewAreaManager.instance;
    }
    this.calculator = new EEWCalculator(require('../../../resource/data/time.json'));
    this.alertedCities = new Set();
    this.bindEvents();
    EewAreaManager.instance = this;
  }

  static getInstance() {
    if (!EewAreaManager.instance) {
      new EewAreaManager();
    }
    return EewAreaManager.instance;
  }

  bindEvents() {
    TREM.variable.events.on('EewRelease', (ans) => this.updateEewArea(ans));
    TREM.variable.events.on('EewUpdate', (ans) => this.updateEewArea(ans));
    TREM.variable.events.on('EewEnd', (ans) => {
      Reflect.deleteProperty(TREM.variable.cache.eewIntensityArea, ans.data.id);
      this.drawEewArea(true);
    });
  }

  updateEewArea(ans) {
    if (!TREM.constant.SHOW_TREM_EEW && ans.data.author === 'trem') {
      return;
    }

    const area = this.calculator.eewAreaPga(
      ans.data.eq.lat,
      ans.data.eq.lon,
      ans.data.eq.depth,
      ans.data.eq.mag,
    );

    const mergedArea = this.mergeEqArea(area, ans.data.eq.area ?? {});
    TREM.variable.cache.eewIntensityArea[ans.data.id] = mergedArea;
    this.drawEewArea();
  }

  drawEewArea(end = false) {
    if (TREM.variable.cache.show_intensity) {
      return;
    }

    if (!Object.keys(TREM.variable.cache.eewIntensityArea).length) {
      TREM.variable.map.setPaintProperty('town', 'fill-color', TREM.constant.COLOR.MAP.TW_TOWN_FILL);
      return;
    }

    const eewArea = this.processIntensityAreas();
    const highIntensityAreas = {};
    const highIntensityCities = new Set();

    Object.entries(eewArea).forEach(([code, intensity]) => {
      if (intensity >= 5) {
        highIntensityAreas[code] = intensity;
        const location = search_loc_name(parseInt(code));
        if (location) {
          highIntensityCities.add(location.city);
        }
      }
    });

    const newHighIntensityCities = new Set(
      [...highIntensityCities].filter((city) => !this.alertedCities.has(city)),
    );

    if (newHighIntensityCities.size > 0) {
      TREM.variable.events.emit('EewNewAreaAlert', {
        info: {},
        data: {
          city_alert_list: Array.from(highIntensityCities),
          new_city_alert_list: Array.from(newHighIntensityCities),
        },
      });
      newHighIntensityCities.forEach((city) => this.alertedCities.add(city));
    }

    const mapStyle = generateMapStyle(eewArea, end);
    TREM.variable.map.setPaintProperty('town', 'fill-color', mapStyle);

    if (end) {
      this.alertedCities.clear();
    }

    return {
      highIntensityAreas,
      highIntensityCities: Array.from(highIntensityCities),
      newHighIntensityCities: Array.from(newHighIntensityCities),
    };
  }

  mergeEqArea(eewArea, eqArea) {
    const mergedArea = {};

    Object.entries(eewArea).forEach(([code, data]) => {
      if (code !== 'max_i') {
        mergedArea[code] = {
          I: intensity_float_to_int(data.i),
          i: data.i,
          dist: data.dist,
        };
      }
    });

    Object.entries(eqArea).forEach(([intensity, codes]) => {
      const intensityFloat = parseFloat(intensity);
      codes.forEach((code) => {
        if (mergedArea[code].I < intensityFloat) {
          mergedArea[code].I = intensityFloat;
        }
      });
    });

    let maxI = 0;
    Object.values(mergedArea).forEach((data) => {
      if (data.I > maxI) {
        maxI = data.I;
      }
    });
    mergedArea.max_i = maxI;

    return mergedArea;
  }

  processIntensityAreas() {
    const eewArea = {};

    Object.entries(TREM.variable.cache.eewIntensityArea).forEach(([, intensity]) => {
      Object.entries(intensity).forEach(([name, value]) => {
        if (name !== 'max_i') {
          if (!eewArea[name] || eewArea[name] < value.I) {
            eewArea[name] = value.I;
          }
        }
      });
    });

    return eewArea;
  }
}

TREM.class.EewAreaManager = EewAreaManager;

const eewAreaManager = EewAreaManager.getInstance();

module.exports = (...args) => eewAreaManager.drawEewArea(...args);
