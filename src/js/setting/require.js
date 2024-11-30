TREM = JSON.parse(localStorage.getItem('constant'));
const EventEmitter = require('events');
TREM.variable.events = new EventEmitter();

const logger = require('../js/core/utils/logger');

logger.info('Setting start');

require('../js/setting/key');
require('../js/setting/lang');
require('../js/setting/config');
require('../js/setting/drop_down');
require('../js/setting/check_box');
require('../js/setting/login');
require('../js/setting/plugin_list');
