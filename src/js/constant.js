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
    // 0 realtime | 1 replay
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