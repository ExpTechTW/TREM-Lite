const TREM = require("../constant");

TREM.variable.events.on("EewRelease", (ans) => {
  if (ans.data.status == 1) TREM.constant.AUDIO.ALERT.play();
  else TREM.constant.AUDIO.EEW.play();
});

TREM.variable.events.on("EewAlert", (ans) => TREM.constant.AUDIO.ALERT.play());

TREM.variable.events.on("EewUpdate", (ans) => TREM.constant.AUDIO.UPDATE.play());