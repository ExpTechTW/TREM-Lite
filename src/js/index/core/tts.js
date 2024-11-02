const logger = require("../utils/logger");

const TREM = require("../constant");

const Speech = require("speak-tts");

const speech = new Speech.default();

speech.init().then((data) => {
  speech.setLanguage("zh-TW");
  speech.setRate(1.8);
  TREM.variable.speech = speech;
  logger.info("Speech ready!");
}).catch(e => {
  logger.error(`Speech error -> ${e}`);
});