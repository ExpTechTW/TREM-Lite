const logger = require('../js/core/utils/logger');

logger.info('Setting start');

require('../js/core/plugin')('setting');

require('../js/setting/constant');
require('../js/core/config');
require('../js/setting/nav');
require('../js/setting/lang');
require('../js/setting/drop_down');
require('../js/setting/check_box');
require('../js/setting/plugin_list');
require('../js/setting/reset');
require('../js/setting/main');
