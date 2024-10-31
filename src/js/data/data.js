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

      if (!TREM.variable.data.rts || !data.rts || TREM.variable.data.rts.time < data.rts.time) {
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
  const EXPIRY_TIME = 240 * 1000;

  TREM.variable.data.eew = TREM.variable.data.eew.filter(item =>
    item.eq &&
           item.eq.time &&
           (currentTime - item.eq.time <= EXPIRY_TIME + 1000) &&
           !item.EewEnd,
  );

  newData.forEach(data => {
    if (currentTime - data.eq.time <= EXPIRY_TIME && !data.EewEnd) {
      const existingIndex = TREM.variable.data.eew.findIndex(item => item.id === data.id);

      if (existingIndex !== -1) {
        if (data.serial > TREM.variable.data.eew[existingIndex].serial) {
          TREM.variable.events.emit("EewUpdate", {
            info: {
              type: TREM.variable.play_mode,
            },
            data: data,
          });

          if (!TREM.variable.data.eew[existingIndex].status && data.status == 1)
            TREM.variable.events.emit("EewAlert", {
              info: {
                type: TREM.variable.play_mode,
              },
              data: data,
            });

          TREM.variable.data.eew[existingIndex] = data;
        }
      } else {
        TREM.variable.data.eew.push(data);

        TREM.variable.events.emit("EewRelease", {
          info: {
            type: TREM.variable.play_mode,
          },
          data: data,
        });

        if (data.status == 1)
          TREM.variable.events.emit("EewAlert", {
            info: {
              type: TREM.variable.play_mode,
            },
            data: data,
          });
      }
    } else if (data.EewEnd) {
      const existingIndex = TREM.variable.data.eew.findIndex(item => item.id === data.id);
      if (existingIndex !== -1) {
        TREM.variable.data.eew.splice(existingIndex, 1);
        TREM.variable.events.emit("EewEnd", {
          info: {
            type: TREM.variable.play_mode,
          },
          data: data,
        });
      }
    }
  });

  TREM.variable.events.emit("DataEew", {
    info: {
      type: TREM.variable.play_mode,
    },
    data: TREM.variable.data.eew,
  });
}