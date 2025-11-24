const TREM = require('../constant');
const now = require('../utils/ntp');
const http = require('./http');

const fs = require('fs-extra');
const path = require('path');
const { app } = require('@electron/remote');

const replayDir = path.join(app.getPath('userData'), 'replay');

let file_list = [];
let file_index = 0;

class TimeoutManager {
  constructor() {
    this.originalTimeouts = {
      LOOP: TREM.constant.HTTP_TIMEOUT.LOOP,
      RTS: TREM.constant.HTTP_TIMEOUT.RTS,
      EEW: TREM.constant.HTTP_TIMEOUT.EEW,
    };

    this.MIN_TIMEOUT = 1000;
    this.MAX_TIMEOUT = 10000;
    this.ADJUST_STEP = 500;
    this.lastAdjustTime = Date.now();
    this.failureCount = 0;
  }

  adjustTimeouts(data) {
    const now = Date.now();
    if (now - this.lastAdjustTime < 2000) {
      return true;
    }

    this.lastAdjustTime = now;

    if (!data.eew && !data.rts) {
      this.failureCount = Math.min(this.failureCount + 1, 10);

      const increaseAmount = this.ADJUST_STEP * this.failureCount;

      ['LOOP', 'RTS', 'EEW'].forEach((type) => {
        const currentTimeout = TREM.constant.HTTP_TIMEOUT[type];
        const newTimeout = Math.min(
          currentTimeout + increaseAmount,
          this.MAX_TIMEOUT,
        );

        if (newTimeout !== currentTimeout) {
          console.log(`[TimeoutManager] ${type} timeout increased to ${newTimeout}ms`);
          TREM.constant.HTTP_TIMEOUT[type] = newTimeout;
        }
      });

      return false;
    }
    else {
      this.failureCount = Math.max(0, Math.floor(this.failureCount / 2));

      const currentTimeout = TREM.constant.HTTP_TIMEOUT.LOOP;
      if (currentTimeout <= this.originalTimeouts.LOOP) {
        return true;
      }

      const decreaseAmount = this.ADJUST_STEP * (this.failureCount + 1);

      ['LOOP', 'RTS', 'EEW'].forEach((type) => {
        const currentTimeout = TREM.constant.HTTP_TIMEOUT[type];
        const newTimeout = Math.max(
          this.originalTimeouts[type],
          currentTimeout - decreaseAmount,
        );

        if (newTimeout !== currentTimeout) {
          console.log(`[TimeoutManager] ${type} timeout decreased to ${newTimeout}ms`);
          TREM.constant.HTTP_TIMEOUT[type] = newTimeout;
        }
      });

      return true;
    }
  }

  reset() {
    Object.keys(this.originalTimeouts).forEach((type) => {
      TREM.constant.HTTP_TIMEOUT[type] = this.originalTimeouts[type];
    });
    this.lastAdjustTime = Date.now();
    this.failureCount = 0;
  }
}

const timeoutManager = new TimeoutManager();

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
      }, 100);
    });

    fs.readdir(replayDir, (err, list) => {
      if (!list) {
        return;
      }

      list = list.filter((file) => file !== '.DS_Store' && file.endsWith('.json'));

      if (list.length) {
        TREM.variable.play_mode = 3;
        TREM.variable.replay.start_time = Number(list[0].replace('.json', ''));
        file_list = list;
      }
    });
  }

  async fetchData() {
    const localNow = Date.now();

    if (localNow - this.lastFetchTime < TREM.constant.HTTP_TIMEOUT.LOOP) {
      return;
    }
    this.lastFetchTime = localNow;

    if (TREM.variable.play_mode === 3) {
      // replay (file)
      if (file_index >= file_list.length - 1) {
        TREM.variable.play_mode = 0;
        return;
      }
      file_index++;
      fs.readFile(path.join(replayDir, file_list[file_index]), (err, data) => {
        const json = JSON.parse(data.toString());
        // console.log(json);

        TREM.variable.data.rts = json.rts;
        TREM.variable.events.emit('DataRts', {
          info: { type: TREM.variable.play_mode },
          data: json.rts,
        });
        this.processEEWData(json.eew);
        this.processIntensityData(json.intensity);
      });
      return null;
    }

    const data = await http((TREM.variable.play_mode == 0 || TREM.variable.play_mode == 1) ? null : now());

    if (!timeoutManager.adjustTimeouts(data)) {
      return;
    }

    if (TREM.variable.play_mode == 0 || TREM.variable.play_mode == 2) {
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
    const STATUS_3_TIMEOUT = 60 * 1000;

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
            const method = data.author === 'trem' ? 'nsspe' : 'eew';
            TREM.variable.data.eew.push({ ...data, method });
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

        if (data.eq.mag && data.eq.mag != 1) {
          data.method = 'eew';
        }

        if (data.status == 3 && TREM.variable.data.eew[existingIndex].status != data.status) {
          TREM.variable.events.emit('EewCancel', eventData);
        }

        if (TREM.variable.data.eew[existingIndex].status != 1 && data.status == 1) {
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
        item.time
        && (currentTime - item.time > EXPIRY_TIME || item.LpgmEnd),
      )
      .forEach((data) => {
        TREM.variable.events.emit('LpgmEnd', {
          info: { type: TREM.variable.play_mode },
          data: { ...data, LpgmEnd: true },
        });
      });

    TREM.variable.data.lpgm = TREM.variable.data.lpgm.filter((item) =>
      item.time
      && currentTime - item.time <= EXPIRY_TIME
      && !item.LpgmEnd,
    );

    newData.forEach((data) => {
      if (!data.id || data.LpgmEnd) {
        return;
      }

      const existingIndex = TREM.variable.data.lpgm.findIndex((item) => item.id == data.id);
      const eventData = {
        info: { type: TREM.variable.play_mode },
        data,
      };

      if (existingIndex == -1) {
        data.id = Number(data.id);
        data.time = now();
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

TREM.class.DataManager = DataManager;

const dataManager = DataManager.getInstance();

module.exports = {
  fetchData: (...args) => dataManager.fetchData(...args),
  processEEWData: (...args) => dataManager.processEEWData(...args),
  processIntensityData: (...args) => dataManager.processIntensityData(...args),
  processLpgmData: (...args) => dataManager.processLpgmData(...args),
};
