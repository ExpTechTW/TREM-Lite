const TREM = {
  constant: {

  },

  variable: {
    map  : null,
    time : null,
    data : {
      rts: null,
    },

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