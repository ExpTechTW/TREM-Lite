const EventEmitter = require('events');

const TREM = {
  variable: {
    events: null,
    region: null,
  },
};

TREM.variable.events = new EventEmitter();
TREM.variable.region = require('../../resource/data/region.json');
