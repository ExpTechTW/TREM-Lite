const TREM = require("../constant");

const now = require("../utils/ntp");

const http = require("./http");
const file = require("./file");

let last_fetch_time = 0;

setInterval(async () => {
  const local_now = Date.now();
  if (TREM.variable.play_mode == 3) {
    // replay (file)
    const data = null;
  } else if (TREM.variable.play_mode == 1) {
    // realtime (websocket)
    const data = null;
  } else {
    // http (realtime/replay)
    if (local_now - last_fetch_time < 1000) return;
    last_fetch_time = local_now;

    const data = await http((TREM.variable.play_mode == 0) ? null : now());

    if (!TREM.variable.data.rts || !data.rts || TREM.variable.data.rts.time < data.rts.time) {
      TREM.variable.data.rts = data.rts;
      TREM.variable.events.emit("DataRts", {
        info: {
          type: TREM.variable.play_mode,
        },
        data: data.rts,
      });
    }

    TREM.variable.data.eew = data.eew;
    console.log(data.eew);
    TREM.variable.events.emit("DataEew", {
      info: {
        type: TREM.variable.play_mode,
      },
      data: data.eew,
    });

    if (data.rts) TREM.variable.cache.last_data_time = local_now;
  }
}, 0);