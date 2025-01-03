const TREM = require('../constant');
const { abortAll } = require('../data/http');
const { focus, focus_reset } = require('./focus');

class ReplayControler {
  static instance = null;

  constructor() {
    if (ReplayControler.instance) {
      return ReplayControler.instance;
    }
    ReplayControler.instance = this;
  }

  static getInstance() {
    if (!ReplayControler.instance) {
      new ReplayControler();
    }
    return ReplayControler.instance;
  }

  clear() {
    abortAll();
    TREM.variable.cache.last_data_time = 0;
    TREM.variable.data.rts = null;
    TREM.variable.replay = {
      start_time: 0,
      local_time: 0,
    };
  }

  startReplay(time) {
    this.clear();
    TREM.variable.replay = {
      start_time: Number(time),
      local_time: 0,
    };
    TREM.variable.play_mode = 2;
  }

  stopReplay() {
    TREM.variable.data.eew.forEach((data) => data.EewEnd = 1);
    TREM.variable.data.intensity.forEach((data) => data.IntensityEnd = 1);
    this.clear();
    TREM.variable.cache.int_cache_list = {};
    TREM.variable.play_mode = 0;
    TREM.variable.cache.unstable = 0;
    TREM.variable.cache.intensity_last = {};
    TREM.variable.events.emit('DataRts', {
      info: {
        type: TREM.variable.play_mode,
      },
      data: null,
    });
    TREM.variable.cache.intensity = {
      time: 0,
      max: 0,
    };
    TREM.variable.cache.last_rts_alert = 0;
    if (!TREM.class.FocusManager?.getInstance().getLock()) {
      setTimeout(() => {
        focus_reset();
        focus();
      }, 1500);
    }
  }
}

TREM.class.ReplayControler = ReplayControler;

const replayControler = ReplayControler.getInstance();

module.exports = {
  stopReplay: (...args) => replayControler.stopReplay(...args),
  startReplay: (...args) => replayControler.startReplay(...args),
};
