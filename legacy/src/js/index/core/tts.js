const logger = require('../../core/utils/logger');

const TREM = require('../constant');

const Speech = require('speak-tts');

const speech = new Speech.default();

// 在 init 完成前先掛一個 no-op stub，避免 speech 未 ready 時呼叫端 TypeError
TREM.variable.speech = {
  speak: () => Promise.resolve(),
  speaking: () => false,
  cancel: () => {},
};

speech.init().then(() => {
  speech.setLanguage('zh-TW');
  TREM.variable.speech = speech;
  logger.info('Speech ready!');
}).catch((e) => {
  logger.error(`Speech error -> ${e}`);
});
