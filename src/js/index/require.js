const path = require('path');
const basePath = path.basename(__dirname) === 'view' ? path.join(__dirname, '../js/index') : __dirname;
const isDev = process.defaultApp
  || process.argv[0].includes('node_modules');

let TREM;

if (isDev) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  TREM = require(path.join(basePath, 'constant'));
}

const logger = require(path.join(basePath, '../core/utils/logger'));

logger.info('App start');

const copyMissingTremFiles = require(path.join(basePath, 'plugin_init'));

(async () => {
  try {
    await copyMissingTremFiles();
  }
  catch (e) {
    console.error('Init error:', e);
  }

  localStorage.setItem('loaded-plugins', JSON.stringify([]));

  // require('../core/config');
  require(path.join(basePath, '../core/plugin')).createPluginLoader('index');

  require(path.join(basePath, 'nav'));
  require(path.join(basePath, 'lang'));
  require(path.join(basePath, 'event'));
  require(path.join(basePath, 'map'));
  require(path.join(basePath, 'data/data'));

  require(path.join(basePath, 'core/resource'));
  require(path.join(basePath, 'core/tts'));
  require(path.join(basePath, 'core/rts'));
  require(path.join(basePath, 'core/eew'));
  require(path.join(basePath, 'core/loop'));
  require(path.join(basePath, 'core/estimate'));
  require(path.join(basePath, 'core/audio'));
  require(path.join(basePath, 'core/focus'));
  require(path.join(basePath, 'core/report'));
  require(path.join(basePath, 'core/intensity'));
  require(path.join(basePath, 'core/lpgm'));
  require(path.join(basePath, 'core/window'));
})();
