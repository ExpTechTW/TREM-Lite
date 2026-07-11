const EventEmitter = require('events');

const TREM = {
  constant: {
    HTTP_TIMEOUT: {
      PLUGIN_INFO: 3000,
    },
  },
  variable: {
    events: null,
    region: null,

    city: [],
  },
};

TREM.variable.events = new EventEmitter();
TREM.variable.region = require('../../resource/data/region.json');

module.exports = TREM;
