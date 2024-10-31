const TREM = require("../constant");

TREM.variable.events.on("EewRelease", (ans) => {
  if (!TREM.constant.SHOW_TREM_EEW && ans.data.author == "trem") return;
  if (ans.data.status == 1) TREM.constant.AUDIO.ALERT.play();
  else TREM.constant.AUDIO.EEW.play();
});

TREM.variable.events.on("EewAlert", (ans) => {
  if (!TREM.constant.SHOW_TREM_EEW && ans.data.author == "trem") return;
  TREM.constant.AUDIO.ALERT.play();
});

TREM.variable.events.on("EewUpdate", (ans) => {
  if (!TREM.constant.SHOW_TREM_EEW && ans.data.author == "trem") return;
  TREM.constant.AUDIO.UPDATE.play();
});