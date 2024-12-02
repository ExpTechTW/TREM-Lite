const logger = require('../js/core/utils/logger');

logger.info('Setting start');

require('../js/core/config');
require('../js/plugin_edit/key');
require('../js/plugin_edit/main');
require('../js/plugin_edit/lang');
require('../js/core/plugin');
