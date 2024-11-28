const TREM = require('../constant');
const now = require('../utils/ntp');
const http = require('./http');
class DataManager {
  static instance = null;

  constructor() {
    if (DataManager.instance) {
      return DataManager.instance;
    }
    this.lastFetchTime = 0;
    this.initialize();
    DataManager.instance = this;
  }

  static getInstance() {
    if (!DataManager.instance) {
      new DataManager();
    }
    return DataManager.instance;
  }

  initialize() {
    TREM.variable.events.on('MapLoad', () => {
      setInterval(async () => {
        await this.fetchData();
      }, 0);
    });
  }

  async fetchData() {
    const localNow = Date.now();

    if (TREM.variable.play_mode === 3) {
      // replay (file)
      return null;
    }
    else if (TREM.variable.play_mode === 1) {
      // realtime (websocket)
      return null;
    }

    // http (realtime/replay)
    if (localNow - this.lastFetchTime < 1000) {
      return;
    }
    this.lastFetchTime = localNow;

    const data = await http((TREM.variable.play_mode === 0) ? null : now());

    if (!TREM.variable.data.rts
      || (!data.rts && ((localNow - TREM.variable.cache.last_data_time) > TREM.constant.LAST_DATA_TIMEOUT_ERROR))
      || TREM.variable.data.rts.time < (data.rts?.time ?? 0)) {
      TREM.variable.data.rts = data.rts;
      TREM.variable.events.emit('DataRts', {
        info: { type: TREM.variable.play_mode },
        data: data.rts,
      });
    }

    if (data.eew) {
      this.processEEWData(data.eew);
    }
    else {
      this.processEEWData();
    }

    if (data.intensity) {
      this.processIntensityData(data.intensity);
    }

    if (data.lpgm) {
      this.processLpgmData(data.lpgm);
    }

    if (data.rts) {
      TREM.variable.cache.last_data_time = localNow;
    }
  }

  processEEWData(newData = []) {
    const currentTime = now();
    const EXPIRY_TIME = 240 * 1000;
    const STATUS_3_TIMEOUT = 30 * 1000;

    TREM.variable.data.eew
      .filter((item) =>
        item.eq?.time && (
          currentTime - item.eq.time > EXPIRY_TIME
          || item.EewEnd
          || (item.status === 3 && currentTime - item.status3Time > STATUS_3_TIMEOUT)
        ),
      )
      .forEach((data) => {
        TREM.variable.events.emit('EewEnd', {
          info: { type: TREM.variable.play_mode },
          data: { ...data, EewEnd: true },
        });
      });

    TREM.variable.data.eew = TREM.variable.data.eew.filter((item) =>
      item.eq?.time
      && currentTime - item.eq.time <= EXPIRY_TIME
      && !item.EewEnd
      && !(item.status === 3 && currentTime - item.status3Time > STATUS_3_TIMEOUT),
    );

    newData.forEach((data) => {
      if (!data.eq?.time || currentTime - data.eq.time > EXPIRY_TIME || data.EewEnd) {
        return;
      }

      const existingIndex = TREM.variable.data.eew.findIndex((item) => item.id == data.id);
      const eventData = {
        info: { type: TREM.variable.play_mode },
        data,
      };

      if (existingIndex == -1) {
        if (!TREM.variable.cache.eew_last[data.id]) {
          if (TREM.constant.EEW_AUTHOR.includes(data.author)) {
            TREM.variable.cache.eew_last[data.id] = {
              last_time: currentTime,
              serial: 1,
            };
            TREM.variable.data.eew.push(data);
            TREM.variable.events.emit('EewRelease', eventData);
          }
          return;
        }
      }

      if (TREM.variable.cache.eew_last[data.id] && TREM.variable.cache.eew_last[data.id].serial < data.serial) {
        TREM.variable.cache.eew_last[data.id].serial = data.serial;

        if (data.status === 3) {
          data.status3Time = currentTime;
        }

        TREM.variable.events.emit('EewUpdate', eventData);

        if (!TREM.variable.data.eew[existingIndex].status && data.status == 1) {
          TREM.variable.events.emit('EewAlert', eventData);
        }

        TREM.variable.data.eew[existingIndex] = data;
      }
    });

    this.cleanupCache('eew_last');

    TREM.variable.events.emit('DataEew', {
      info: { type: TREM.variable.play_mode },
      data: TREM.variable.data.eew,
    });
  }

  isAreaDifferent(area1, area2) {
    if (!area1 || !area2) {
      return true;
    }

    const keys1 = Object.keys(area1);
    const keys2 = Object.keys(area2);

    if (keys1.length !== keys2.length) {
      return true;
    }

    return keys1.some((key) => {
      const arr1 = area1[key] || [];
      const arr2 = area2[key] || [];
      if (arr1.length !== arr2.length) {
        return true;
      }
      return !arr1.every((val) => arr2.includes(val));
    });
  }

  processIntensityData(newData = []) {
    const currentTime = now();
    const EXPIRY_TIME = 600 * 1000;

    TREM.variable.data.intensity
      .filter((item) =>
        item.id
        && (currentTime - item.id > EXPIRY_TIME || item.IntensityEnd),
      )
      .forEach((data) => {
        TREM.variable.events.emit('IntensityEnd', {
          info: { type: TREM.variable.play_mode },
          data: { ...data, IntensityEnd: true },
        });
      });

    TREM.variable.data.intensity = TREM.variable.data.intensity.filter((item) =>
      item.id
      && currentTime - item.id <= EXPIRY_TIME
      && !item.IntensityEnd,
    );

    newData.forEach((data) => {
      if (!data.id || currentTime - data.id > EXPIRY_TIME || data.IntensityEnd) {
        return;
      }

      const existingIndex = TREM.variable.data.intensity.findIndex((item) => item.id == data.id);
      const eventData = {
        info: { type: TREM.variable.play_mode },
        data,
      };

      if (existingIndex == -1) {
        if (!TREM.variable.cache.intensity_last[data.id]) {
          TREM.variable.cache.intensity_last[data.id] = {
            last_time: currentTime,
            serial: 1,
          };
          TREM.variable.data.intensity.push(data);
          TREM.variable.events.emit('IntensityRelease', eventData);
          return;
        }
      }

      if (TREM.variable.cache.intensity_last[data.id] && TREM.variable.cache.intensity_last[data.id].serial < data.serial) {
        TREM.variable.cache.intensity_last[data.id].serial = data.serial;
        if (this.isAreaDifferent(data.area, TREM.variable.data.intensity[existingIndex].area)) {
          TREM.variable.events.emit('IntensityUpdate', eventData);
          TREM.variable.data.intensity[existingIndex] = data;
        }
      }
    });

    this.cleanupCache('intensity_last');

    TREM.variable.events.emit('DataIntensity', {
      info: { type: TREM.variable.play_mode },
      data: TREM.variable.data.intensity,
    });
  }

  processLpgmData(newData = []) {
    const currentTime = now();
    const EXPIRY_TIME = 600 * 1000;

    TREM.variable.data.lpgm
      .filter((item) =>
        item.id
        && (currentTime - item.id > EXPIRY_TIME || item.LpgmEnd),
      )
      .forEach((data) => {
        TREM.variable.events.emit('LpgmEnd', {
          info: { type: TREM.variable.play_mode },
          data: { ...data, LpgmEnd: true },
        });
      });

    TREM.variable.data.lpgm = TREM.variable.data.lpgm.filter((item) =>
      item.id
      && currentTime - item.id <= EXPIRY_TIME
      && !item.LpgmEnd,
    );

    newData.forEach((data) => {
      if (!data.id || currentTime - data.id > EXPIRY_TIME || data.LpgmEnd) {
        return;
      }

      const existingIndex = TREM.variable.data.lpgm.findIndex((item) => item.id == data.id);
      const eventData = {
        info: { type: TREM.variable.play_mode },
        data,
      };

      if (existingIndex == -1) {
        TREM.variable.data.lpgm.push(data);
        TREM.variable.events.emit('LpgmRelease', eventData);
      }
    });

    TREM.variable.events.emit('DataLpgm', {
      info: { type: TREM.variable.play_mode },
      data: TREM.variable.data.lpgm,
    });
  }

  cleanupCache(cacheKey) {
    const currentTime = now();
    Object.keys(TREM.variable.cache[cacheKey]).forEach((id) => {
      const item = TREM.variable.cache[cacheKey][id];
      if (currentTime - item.last_time > 600000) {
        delete TREM.variable.cache[cacheKey][id];
      }
    });
  }
}

const dataManager = DataManager.getInstance();

module.exports = {
  fetchData: (...args) => dataManager.fetchData(...args),
  processEEWData: (...args) => dataManager.processEEWData(...args),
  processIntensityData: (...args) => dataManager.processIntensityData(...args),
  processLpgmData: (...args) => dataManager.processLpgmData(...args),
};
