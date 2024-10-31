const TREM = {
  constant: {
    COLOR: {
      MAP: {
        BACKGROUND        : "#1f2025",
        TW_COUNTY_FILL    : "#3F4045",
        TW_TOWN_FILL      : "#3F4045",
        TW_COUNTY_OUTLINE : "#a9b4bc",
        GLOBAL_FILL       : "#3F4045",
      },
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
        0 : "#202020",
        1 : "#003264",
        2 : "#0064c8",
        3 : "#1e9632",
        4 : "#ffc800",
        5 : "#ff9600",
        6 : "#ff6400",
        7 : "#ff0000",
        8 : "#c00000",
        9 : "#9600c8",
      },
      INTENSITY_TEXT: {
        0 : "#ffffff",
        1 : "#ffffff",
        2 : "#ffffff",
        3 : "#ffffff",
        4 : "#000000",
        5 : "#000000",
        6 : "#000000",
        7 : "#ffffff",
        8 : "#ffffff",
        9 : "#ffffff",
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
      API : ["api-1.exptech.dev", "api-2.exptech.dev"],
      LB  : [
        "lb-1.exptech.dev",
        "lb-2.exptech.dev",
        "lb-3.exptech.dev",
        "lb-4.exptech.dev",
      ],
      REPLAY: ["api-2.exptech.dev"],
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
      EEW      : 1500,
    },

    LAST_DATA_TIMEOUT_ERROR: 3000,

    EEW_AUTHOR: ["trem"],
  },

  variable: {
    map    : null,
    events : null,
    time   : null,
    data   : {
      rts       : null,
      intensity : null,
      report    : null,
      eew       : [],
    },
    // 0 realtime (http) | 1 realtime (websocket) | 2 replay (http) | 3 replay (file)
    play_mode : 2,
    replay    : {
      start_time : 1730024508712,
      local_time : 0,
    },
    station: null,

    // 不要動下方的東西
    cache: {
      time: {
        syncedTime : 0,
        lastSync   : 0,
      },
      last_data_time: 0,
    },
  },
};

TREM.constant.AUDIO.SHINDO0.volume = 0.4;
TREM.constant.AUDIO.UPDATE.volume = 0.2;

module.exports = TREM;
