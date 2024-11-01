const TREM = require("../constant");

const Speech = require("speak-tts");

const speech = new Speech.default();

(async () => {
  await speech.init();
  speech.setLanguage("zh-TW");
  // speech.setLanguage("ja-JP");
  // speech.setVoice("O-Ren");
  speech.setVoice("Meijia");
  speech.setRate(1.2);
  TREM.variable.speech = speech;
})();