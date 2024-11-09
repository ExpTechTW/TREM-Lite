const TREM = require('../constant');

function now() {
  if (TREM.variable.play_mode == 2 || TREM.variable.play_mode == 3) {
    if (!TREM.variable.replay.local_time) TREM.variable.replay.local_time = Date.now();
    return TREM.variable.replay.start_time + (Date.now() - TREM.variable.replay.local_time);
  }
  if (!TREM.variable.cache.time.syncedTime || !TREM.variable.cache.time.lastSync) return Date.now();
  const offset = Date.now() - TREM.variable.cache.time.lastSync;
  return TREM.variable.cache.time.syncedTime + offset;
}

module.exports = now;
