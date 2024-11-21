let TREM = JSON.parse(localStorage.getItem('constant'));

const logger = require('../js/core/utils/logger');

logger.info('Setting start');

require('../js/setting/key');
require('../js/setting/lang');
require('../js/setting/drop_down');
require('../js/setting/check_box');
