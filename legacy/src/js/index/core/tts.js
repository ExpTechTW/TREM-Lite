const logger = require('../../core/utils/logger');

const TREM = require('../constant');

const Speech = require('speak-tts');

const speech = new Speech.default();

speech.init().then(() => {
  speech.setLanguage('zh-TW');
  TREM.variable.speech = speech;
  logger.info('Speech ready!');
}).catch((e) => {
  logger.error(`Speech error -> ${e}`);
});
