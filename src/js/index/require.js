const isDev = process.defaultApp
  || process.argv[0].includes('node_modules');

let TREM;

if (isDev) {
  TREM = require('../js/index/constant');
}

const logger = require('../js/core/utils/logger');

logger.info('App start');

require('../js/index/nav');
require('../js/index/lang');
require('../js/index/event');
require('../js/index/map');
require('../js/index/data/data');

require('../js/index/core/resource');
require('../js/index/core/tts');
require('../js/index/core/rts');
require('../js/index/core/eew');
require('../js/index/core/loop');
require('../js/index/core/estimate');
require('../js/index/core/audio');
require('../js/index/core/focus');
require('../js/index/core/report');
require('../js/index/core/intensity');
require('../js/index/core/window');

require('../js/core/plugin');

const { ipcRenderer } = require('electron');

ipcRenderer.send('toggle-pip');
