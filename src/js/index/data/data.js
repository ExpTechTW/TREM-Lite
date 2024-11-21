const TREM = require('../constant');

const now = require('../utils/ntp');

const http = require('./http');
const file = require('./file');

let last_fetch_time = 0;

class DataManager {
  static instance = null;

  constructor() {
    if (DataManager.instance) {
      return DataManager.instance;
    }
    this.bindEvents();
    DataManager.instance = this;
  }

  static getInstance() {
    if (!DataManager.instance) {
      new DataManager();
    }
    return DataManager.instance;
  }

  bindEvents() {
    TREM.variable.events.on('MapLoad', () => this.onMapLoad());
  }

  onMapLoad() {
    setInterval(async () => {
      const local_now = Date.now();
      if (TREM.variable.play_mode == 3) {
        // replay (file)
        const data = null;
      }
      else if (TREM.variable.play_mode == 1) {
        // realtime (websocket)
        const data = null;
      }
      else {
        // http (realtime/replay)
        if (local_now - last_fetch_time < 1000) {
          return;
        }
        last_fetch_time = local_now;

        const data = await http((TREM.variable.play_mode == 0) ? null : now());

        if (!TREM.variable.data.rts || (!data.rts && ((Date.now() - TREM.variable.cache.last_data_time) > TREM.constant.LAST_DATA_TIMEOUT_ERROR)) || TREM.variable.data.rts.time < (data.rts?.time ?? 0)) {
          TREM.variable.data.rts = data.rts;
          TREM.variable.events.emit('DataRts', {
            info: {
              type: TREM.variable.play_mode,
            },
            data: data.rts,
          });
        }

        if (data.eew) {
          this.EEWData(data.eew);
        }
        else {
          this.EEWData();
        }

        if (data.intensity) {
          this.IntensityData(data.intensity);
        }

        if (data.rts) {
          TREM.variable.cache.last_data_time = local_now;
        }
      }
    }, 0);
  }

  EEWData(newData = []) {
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

    Object.keys(TREM.variable.cache.eew_last).forEach((id) => {
      const item = TREM.variable.cache.eew_last[id];
      if (currentTime - item.last_time > 600000) {
        Reflect.deleteProperty(TREM.variable.cache.eew_last, id);
      }
    });

    TREM.variable.events.emit('DataEew', {
      info: { type: TREM.variable.play_mode },
      data: TREM.variable.data.eew,
    });
  }

  IntensityData(newData = []) {
    const currentTime = now();
    const EXPIRY_TIME = 240 * 1000;

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
        TREM.variable.events.emit('IntensityUpdate', eventData);

        TREM.variable.data.intensity[existingIndex] = data;
      }
    });

    Object.keys(TREM.variable.cache.intensity_last).forEach((id) => {
      const item = TREM.variable.cache.intensity_last[id];
      if (currentTime - item.last_time > 600000) {
        Reflect.deleteProperty(TREM.variable.cache.intensity_last, id);
      }
    });

    TREM.variable.events.emit('DataIntensity', {
      info: { type: TREM.variable.play_mode },
      data: TREM.variable.data.intensity,
    });
  }
}

TREM.class.DataManager = DataManager;

const dataManager = DataManager.getInstance();
module.exports = dataManager;
