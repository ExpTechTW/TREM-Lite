const TREM = require("../constant");

const logger = require("../utils/logger");
const { intensity_list } = require("../utils/utils");

const tts_cache = {};
let tts_eew_alert_lock = false;

TREM.variable.events.on("EewRelease", (ans) => {
  if (!TREM.constant.SHOW_TREM_EEW && ans.data.author == "trem") return;
  if (ans.data.status == 1) TREM.constant.AUDIO.ALERT.play();
  else TREM.constant.AUDIO.EEW.play();

  tts_cache[ans.data.id] = {
    last : { loc: "", i: -1 },
    now  : { loc: ans.data.eq.loc, i: ans.data.eq.max },
  };
});

TREM.variable.events.on("EewAlert", (ans) => {
  if (!TREM.constant.SHOW_TREM_EEW && ans.data.author == "trem") return;
  TREM.constant.AUDIO.ALERT.play();
});

TREM.variable.events.on("EewUpdate", (ans) => {
  if (!TREM.constant.SHOW_TREM_EEW && ans.data.author == "trem") return;
  TREM.constant.AUDIO.UPDATE.play();

  tts_cache[ans.data.id].now.loc = ans.data.eq.loc;
  tts_cache[ans.data.id].now.i = ans.data.eq.max;
});

TREM.variable.events.on("EewEnd", (ans) => {
  delete tts_cache[ans.data.id];
});

TREM.variable.events.on("RtsPga2", (ans) => {
  TREM.constant.AUDIO.PGA2.play();
});

TREM.variable.events.on("RtsPga1", (ans) => {
  TREM.constant.AUDIO.PGA1.play();
});

TREM.variable.events.on("RtsShindo2", (ans) => {
  TREM.constant.AUDIO.SHINDO2.play();
});

TREM.variable.events.on("RtsShindo1", (ans) => {
  TREM.constant.AUDIO.SHINDO1.play();
});

TREM.variable.events.on("RtsShindo0", (ans) => {
  TREM.constant.AUDIO.SHINDO0.play();
});

TREM.variable.events.on("EewNewAreaAlert", (ans) => {
  if (!TREM.variable.tts) return;
  if (TREM.variable.speech.speaking()) TREM.variable.speech.cancel();
  tts_eew_alert_lock = true;
  TREM.variable.speech.speak({
    text      : `緊急地震速報，${ans.data.city_alert_list.join("、")}，請做好應對強烈搖晃的準備`,
    queue     : false,
    listeners : {
      onend: () => {
        tts_eew_alert_lock = false;
      },
    },
  });
});

if (TREM.variable.tts)
  setInterval(() => {
    if (tts_eew_alert_lock) return;
    for (const id of Object.keys(tts_cache))
      if (tts_cache[id].now.i > tts_cache[id].last.i) {
        tts_cache[id].last.loc = tts_cache[id].now.loc;
        TREM.variable.speech.speak({ text: `${tts_cache[id].last.loc}發生地震`, queue: true });

        tts_cache[id].last.i = tts_cache[id].now.i;
        TREM.variable.speech.speak({ text: `預估最大震度${(!tts_cache[id].last.i) ? "不明" : intensity_list[tts_cache[id].last.i].replace("⁻", "弱").replace("⁺", "強")}`, queue: true });
      }
  }, 3000);