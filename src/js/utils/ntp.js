const TREM = require("../constant");

function now() {
  if (!TREM.variable.cache.time.syncedTime || !TREM.variable.cache.time.lastSync) return Date.now();
  const offset = Date.now() - TREM.variable.cache.time.lastSync;
  return TREM.variable.cache.time.syncedTime + offset;
}

module.exports = now;