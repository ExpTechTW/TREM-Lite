const logger = require("../js/index/utils/logger");

logger.info("App start");

require("../js/index/lang");
require("../js/index/event");
require("../js/index/map");
require("../js/index/data/data");
require("../js/index/nav");

require("../js/index/core/resource");
require("../js/index/core/tts");
require("../js/index/core/rts");
require("../js/index/core/eew");
require("../js/index/core/loop");
require("../js/index/core/estimate");
require("../js/index/core/audio");
require("../js/index/core/focus");
require("../js/index/core/report");