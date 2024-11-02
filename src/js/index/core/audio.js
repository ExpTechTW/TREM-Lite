const TREM = require("../constant");

const { intensity_list } = require("../utils/utils");

const tts_cache = {};
let tts_eew_alert_lock = false;

const priorityRules = {
  pga: {
    "PGA2" : ["PGA1", "PGA0"],
    "PGA1" : ["PGA0"],
  },
  shindo: {
    "SHINDO2" : ["SHINDO1", "SHINDO0"],
    "SHINDO1" : ["SHINDO0"],
  },
  eew: {
    "ALERT": ["EEW"],
  },
};

class AudioQueue {
  constructor() {
    this.queue = [];
    this.isPlaying = false;
  }

  getAudioName(audio) {
    for (const [key, value] of Object.entries(TREM.constant.AUDIO))
      if (value === audio) return key;
    return null;
  }

  removeConflictingAudios(newAudio, rules) {
    const audioName = this.getAudioName(newAudio);
    if (!audioName || !rules[audioName]) return;

    const toRemove = rules[audioName];
    this.queue = this.queue.filter(queuedAudio => {
      const queuedAudioName = this.getAudioName(queuedAudio);
      return !toRemove.includes(queuedAudioName);
    });
  }

  add(audio, rules = {}) {
    this.removeConflictingAudios(audio, rules);

    const audioName = this.getAudioName(audio);
    if (audioName === "ALERT") {
      this.queue.push(audio);
      this.queue.push(audio);
    } else
      this.queue.push(audio);

    this.playNext();
  }

  playNext() {
    if (this.isPlaying || this.queue.length === 0) return;

    this.isPlaying = true;
    const audio = this.queue.shift();

    audio.pause();
    audio.currentTime = 0;

    audio.play().then(() => {
      audio.onended = () => {
        this.isPlaying = false;
        this.playNext();
      };
    }).catch(error => {
      console.error("音效播放失敗:", error);
      this.isPlaying = false;
      this.playNext();
    });
  }

  clear() {
    this.queue = [];
    this.isPlaying = false;
  }
}

const audioQueues = {
  eew    : new AudioQueue(),
  pga    : new AudioQueue(),
  shindo : new AudioQueue(),
  update : new AudioQueue(),
};

TREM.variable.events.on("EewRelease", (ans) => {
  if (!TREM.constant.SHOW_TREM_EEW && ans.data.author == "trem") return;

  if (ans.data.status == 1)
    audioQueues.eew.add(TREM.constant.AUDIO.ALERT, priorityRules.eew);
  else
    audioQueues.eew.add(TREM.constant.AUDIO.EEW, priorityRules.eew);

  tts_cache[ans.data.id] = {
    last : { loc: "", i: -1 },
    now  : { loc: ans.data.eq.loc, i: ans.data.eq.max },
  };
});

TREM.variable.events.on("EewAlert", (ans) => {
  if (!TREM.constant.SHOW_TREM_EEW && ans.data.author == "trem") return;
  audioQueues.eew.add(TREM.constant.AUDIO.ALERT, priorityRules.eew);
});

TREM.variable.events.on("EewUpdate", (ans) => {
  if (!TREM.constant.SHOW_TREM_EEW && ans.data.author == "trem") return;
  audioQueues.update.clear();
  audioQueues.update.add(TREM.constant.AUDIO.UPDATE);

  console.log(ans.data, tts_cache);

  tts_cache[ans.data.id].now.loc = ans.data.eq.loc;
  tts_cache[ans.data.id].now.i = ans.data.eq.max;
});

TREM.variable.events.on("EewEnd", (ans) => {
  delete tts_cache[ans.data.id];
});

TREM.variable.events.on("RtsPga2", (ans) => {
  audioQueues.pga.add(TREM.constant.AUDIO.PGA2, priorityRules.pga);
});

TREM.variable.events.on("RtsPga1", (ans) => {
  audioQueues.pga.add(TREM.constant.AUDIO.PGA1, priorityRules.pga);
});

TREM.variable.events.on("RtsShindo2", (ans) => {
  audioQueues.shindo.add(TREM.constant.AUDIO.SHINDO2, priorityRules.shindo);
});

TREM.variable.events.on("RtsShindo1", (ans) => {
  audioQueues.shindo.add(TREM.constant.AUDIO.SHINDO1, priorityRules.shindo);
});

TREM.variable.events.on("RtsShindo0", (ans) => {
  audioQueues.shindo.add(TREM.constant.AUDIO.SHINDO0);
});

TREM.variable.events.on("ReportRelease", (ans) => {
  TREM.constant.AUDIO.REPORT.play();
});

TREM.variable.events.on("EewNewAreaAlert", (ans) => {
  if (!TREM.variable.tts) return;
  if (TREM.variable.speech.speaking()) TREM.variable.speech.cancel();
  tts_eew_alert_lock = true;
  TREM.variable.speech.speak({
    text      : `緊急地震速報，${ans.data.city_alert_list.join("、")}，慎防強烈搖晃`,
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