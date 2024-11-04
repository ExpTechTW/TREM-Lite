const TREM = require("../constant");

const { formatTime } = require("../utils/utils");
const now = require("../utils/ntp");
const refresh_cross = require("./cross");
const refresh_box = require("./box");

const time = document.getElementById("time");

let flash = false;

setInterval(() => {
  if (TREM.variable.play_mode == 2 || TREM.variable.play_mode == 3) {
    time.className = "time-replay";
    time.textContent = formatTime(now());
  } else if ((Date.now() - TREM.variable.cache.last_data_time) > TREM.constant.LAST_DATA_TIMEOUT_ERROR) time.className = "time-error";
  else {
    time.className = "time-normal";
    time.textContent = formatTime(now());
  }
}, 1000);

TREM.variable.events.on("MapLoad", (map) => {
  setInterval(() => {
    flash = !flash;
    refresh_cross(flash);
    refresh_box(flash);
  }, 500);
});