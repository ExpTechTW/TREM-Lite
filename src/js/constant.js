const TREM = {
  constant: {
    COLOR: {
      RTS: {
        intensity_3 : "#0005d0",
        intensity_2 : "#004bf8",
        intensity_1 : "#009EF8",
        intensity0  : "#79E5FD",
        intensity1  : "#49E9AD",
        intensity2  : "#44fa34",
        intensity3  : "#beff0c",
        intensity4  : "#fff000",
        intensity5  : "#ff9300",
        intensity6  : "#fc5235",
        intensity7  : "#b720e9",
      },
      INTENSITY: {
        0 : "",
        1 : "",
        2 : "",
        3 : "",
        4 : "",
        5 : "",
        6 : "",
        7 : "",
        8 : "",
        9 : "",
      },
      EEW: {
        S: {
          WARN  : "#ffaa00",
          ALERT : "#ff0000",
        },
        P: "#00CACA",
      },
    },

    URL: {
      API: [
        "api-1.exptech.dev",
        "api-2.exptech.dev",
      ],
      LB: [
        "lb-1.exptech.dev",
        "lb-2.exptech.dev",
        "lb-3.exptech.dev",
        "lb-4.exptech.dev",
      ],
    },

    AUDIO: {
      ALERT     : new Audio("../audio/ALERT.wav"),
      EEW       : new Audio("../audio/EEW.wav"),
      INTENSITY : new Audio("../audio/INTENSITY.wav"),
      PGA1      : new Audio("../audio/PGA1.wav"),
      PGA2      : new Audio("../audio/PGA2.wav"),
      REPORT    : new Audio("../audio/REPORT.wav"),
      SHINDO0   : new Audio("../audio/SHINDO0.wav"),
      SHINDO1   : new Audio("../audio/SHINDO1.wav"),
      SHINDO2   : new Audio("../audio/SHINDO2.wav"),
      TSUNAMI   : new Audio("../audio/TSUNAMI.wav"),
      UPDATE    : new Audio("../audio/UPDATE.wav"),
    },

    HTTP_TIMEOUT: {
      RESOURCE : 3500,
      RTS      : 1500,
    },
  },

  variable: {
    map    : null,
    events : null,
    time   : null,
    data   : {
      rts       : null,
      intensity : null,
      report    : null,
      eew       : null,
    },
    // 0 realtime (http) | 1 realtime (websocket) | 2 replay (http) | 3 replay (file)
    play_mode : 0,
    station   : null,

    // 不要動下方的東西
    cache: {
      time: {
        syncedTime : 0,
        lastSync   : 0,
      },
    },
  },
};

module.exports = TREM;