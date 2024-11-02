const TREM = require("../constant");

const now = require("../utils/ntp");

const http = require("./http");
const file = require("./file");

let last_fetch_time = 0;

TREM.variable.events.on("MapLoad", (map) => {
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

      if (!TREM.variable.data.rts || (!data.rts && ((Date.now() - TREM.variable.cache.last_data_time) > TREM.constant.LAST_DATA_TIMEOUT_ERROR)) || TREM.variable.data.rts.time < (data.rts?.time ?? 0)) {
        TREM.variable.data.rts = data.rts;
        TREM.variable.events.emit("DataRts", {
          info: {
            type: TREM.variable.play_mode,
          },
          data: data.rts,
        });
      }

      if (data.eew) EEWData(data.eew);
      else EEWData();

      if (data.rts) TREM.variable.cache.last_data_time = local_now;
    }
  }, 0);
});

function EEWData(newData = []) {
  const currentTime = now();
  const EXPIRY_TIME = 255 * 1000;

  TREM.variable.data.eew
    .filter(item =>
      item.eq?.time &&
      (currentTime - item.eq.time > EXPIRY_TIME || item.EewEnd),
    )
    .forEach(data => {
      TREM.variable.events.emit("EewEnd", {
        info : { type: TREM.variable.play_mode },
        data : { ...data, EewEnd: true },
      });
    });

  TREM.variable.data.eew = TREM.variable.data.eew.filter(item =>
    item.eq?.time &&
    currentTime - item.eq.time <= EXPIRY_TIME &&
    !item.EewEnd,
  );

  newData.forEach(data => {
    if (!data.eq?.time || currentTime - data.eq.time > EXPIRY_TIME || data.EewEnd) return;

    const existingIndex = TREM.variable.data.eew.findIndex(item => item.id === data.id);
    const eventData = {
      info: { type: TREM.variable.play_mode },
      data,
    };

    if (existingIndex === -1) {
      if (TREM.constant.EEW_AUTHOR.includes(data.author)) {
        TREM.variable.data.eew.push(data);
        TREM.variable.events.emit("EewRelease", eventData);
      }
      return;
    }

    if (data.serial > TREM.variable.data.eew[existingIndex].serial) {
      TREM.variable.events.emit("EewUpdate", eventData);

      if (!TREM.variable.data.eew[existingIndex].status && data.status === 1)
        TREM.variable.events.emit("EewAlert", eventData);

      TREM.variable.data.eew[existingIndex] = data;
    }
  });

  TREM.variable.events.emit("DataEew", {
    info : { type: TREM.variable.play_mode },
    data : TREM.variable.data.eew,
  });
}