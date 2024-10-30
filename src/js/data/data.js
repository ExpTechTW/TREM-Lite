const TREM = require("../constant");

const realtime = require("./http/realtime");
const replay = require("./http/replay");

let last_fetch_time = 0;

setInterval(() => {
  const local_now = Date.now();
  if (TREM.variable.play_mode == 2) {
    // replay
    const data = null;
  } else if (TREM.variable.play_mode == 1) {
    // realtime (websocket)
    const data = null;
  } else {
    // realtime (http)
    if (local_now - last_fetch_time < 1000) return;
    last_fetch_time = local_now;

    const data = realtime();
    TREM.variable.data.rts = data;
  }
}, 0);