const TREM = require('../constant');
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
    this.clear();
    TREM.variable.play_mode = 0;
    setTimeout(() => {
      focus_reset();
      focus();
    }, 1500);
  }
}

TREM.class.ReplayControler = ReplayControler;

const replayControler = ReplayControler.getInstance();

module.exports = {
  stopReplay: (...args) => replayControler.stopReplay(...args),
  startReplay: (...args) => replayControler.startReplay(...args),
};
