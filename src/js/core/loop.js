const TREM = require("../constant");

const { formatTime } = require("../utils/utils");
const now = require("../utils/ntp");

const time = document.getElementById("time");

setInterval(() => {
  if (TREM.variable.play_mode == 2 || TREM.variable.play_mode == 3) time.className = "time-replay";
  else if (Date.now() - TREM.variable.cache.last_data_time > 3000) time.className = "time-error";
  else time.className = "time-normal";
  time.textContent = formatTime(now());
}, 1000);