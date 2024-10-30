const TREM = {
  constant: {
    INTENSITY_COLOR: {
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
  },

  variable: {
    map  : null,
    time : null,
    data : {
      rts       : null,
      intensity : null,
      report    : null,
      eew       : null,
    },
    // 0 realtime (http) | 1 realtime (websocket) | 2 replay (http) | 3 replay (file)
    play_mode: 0,

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