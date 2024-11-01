const TREM = require("../constant");
const { intensity_list } = require("../utils/utils");

const tts_cache = {};

TREM.variable.events.on("EewRelease", (ans) => {
  if (!TREM.constant.SHOW_TREM_EEW && ans.data.author == "trem") return;
  if (ans.data.status == 1) TREM.constant.AUDIO.ALERT.play();
  else TREM.constant.AUDIO.EEW.play();

  if (TREM.variable.tts) {
    TREM.variable.speech.speak({ text: `${ans.data.eq.loc}發生地震` });

    tts_cache[ans.data.id] = {
      last: {
        loc : ans.data.eq.loc,
        i   : 0,
      },
      now: {
        loc : ans.data.eq.loc,
        i   : ans.data.eq.max,
      },
    };
  }
});

TREM.variable.events.on("EewAlert", (ans) => {
  if (!TREM.constant.SHOW_TREM_EEW && ans.data.author == "trem") return;
  TREM.constant.AUDIO.ALERT.play();
});

TREM.variable.events.on("EewUpdate", (ans) => {
  if (!TREM.constant.SHOW_TREM_EEW && ans.data.author == "trem") return;
  TREM.constant.AUDIO.UPDATE.play();
});

TREM.variable.events.on("EewUpdate", (ans) => {
  delete tts_cache[ans.data.id];
});

setInterval(() => {
  for (const id of Object.keys(tts_cache))
    if (tts_cache[id].now.loc != tts_cache[id].last.loc) {
      tts_cache[id].last.loc = tts_cache[id].now.loc;
      TREM.variable.speech.speak({ text: `${tts_cache[id].last.loc}發生地震` });
    } else if (tts_cache[id].now.i > tts_cache[id].last.i) {
      tts_cache[id].last.i = tts_cache[id].now.i;
      TREM.variable.speech.speak({ text: `預估最大震度${intensity_list[tts_cache[id].last.i].replace("⁻", "弱").replace("⁺", "強")}` });
    }
}, 3000);