const isDev = process.defaultApp
  || process.argv[0].includes('node_modules');

let TREM;

if (isDev) {
  TREM = require('../js/index/constant');
}

const logger = require('../js/core/utils/logger');

logger.info('App start');

const copyMissingTremFiles = require('../js/index/plugin_init');

(async () => {
  await copyMissingTremFiles();

  localStorage.setItem('loaded-plugins', JSON.stringify([]));

  // require('../js/core/config');
  require('../js/core/plugin').createPluginLoader('index');

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
  require('../js/index/core/lpgm');
  require('../js/index/core/window');

  const { processEEWData } = require('../js/index/data/data');

  TREM.test = () => {
    processEEWData([{
      author: 'trem',
      id: '1',
      serial: 1,
      status: 1,
      final: 0,
      replay: true,
      eq: {
        time: Date.now(),
        lon: 120.53,
        lat: 23.17,
        depth: 10,
        mag: 5.8,
        loc: '臺南市楠西區',
        max: 5,
      },
      time: Date.now(),
    }]);
  };
})();
