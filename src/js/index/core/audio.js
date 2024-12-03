const logger = require('../../core/utils/logger');

const TREM = require('../constant');
const now = require('../utils/ntp');
const { intensity_list, formatToChineseTime, int_to_string, findMaxIntensityCity, search_loc_name, formatTimestamp } = require('../utils/utils');

const { BrowserWindow } = require('@electron/remote');
const win = BrowserWindow.fromId(process.env.window * 1);

const Config = require('../../core/config');

class AudioQueue {
  constructor() {
    this.queue = [];
    this.isPlaying = false;
  }

  getAudioName(audio) {
    for (const [key, value] of Object.entries(TREM.constant.AUDIO)) {
      if (value === audio) {
        return key;
      }
    }
    return null;
  }

  removeConflictingAudios(newAudio, rules) {
    const audioName = this.getAudioName(newAudio);
    if (!audioName || !rules[audioName]) {
      return;
    }

    const toRemove = rules[audioName];
    this.queue = this.queue.filter((queuedAudio) => {
      const queuedAudioName = this.getAudioName(queuedAudio);
      return !toRemove.includes(queuedAudioName);
    });
  }

  add(audio, rules = {}) {
    this.removeConflictingAudios(audio, rules);

    const audioName = this.getAudioName(audio);
    if (audioName === 'ALERT') {
      this.queue.push(audio);
      this.queue.push(audio);
    }
    else {
      this.queue.push(audio);
    }

    this.playNext();
  }

  playNext() {
    if (this.isPlaying || this.queue.length === 0) {
      return;
    }

    this.isPlaying = true;
    const audio = this.queue.shift();

    audio.pause();
    audio.currentTime = 0;

    audio.play().then(() => {
      audio.onended = () => {
        this.isPlaying = false;
        this.playNext();
      };
    }).catch((error) => {
      logger.error('音效播放失敗:', error);
      this.isPlaying = false;
      this.playNext();
    });
  }

  clear() {
    this.queue = [];
    this.isPlaying = false;
  }
}

class AudioManager {
  static instance = null;

  constructor() {
    if (AudioManager.instance) {
      return AudioManager.instance;
    }

    this.config = Config.getInstance().getConfig();

    this.ttsCache = {};
    this.ttsEewAlertLock = false;
    this.audioQueues = {
      eew: new AudioQueue(),
      pga: new AudioQueue(),
      shindo: new AudioQueue(),
      update: new AudioQueue(),
    };

    this.priorityRules = {
      pga: {
        PGA2: ['PGA1', 'PGA0'],
        PGA1: ['PGA0'],
      },
      shindo: {
        SHINDO2: ['SHINDO1', 'SHINDO0'],
        SHINDO1: ['SHINDO0'],
      },
      eew: {
        ALERT: ['EEW'],
      },
    };

    this.bindEvents();
    this.initTtsInterval();

    AudioManager.instance = this;
  }

  static getInstance() {
    if (!AudioManager.instance) {
      new AudioManager();
    }
    return AudioManager.instance;
  }

  bindEvents() {
    TREM.variable.events.on('EewRelease', this.handleEewRelease.bind(this));
    TREM.variable.events.on('EewAlert', this.handleEewAlert.bind(this));
    TREM.variable.events.on('EewUpdate', this.handleEewUpdate.bind(this));
    TREM.variable.events.on('EewEnd', this.handleEewEnd.bind(this));
    TREM.variable.events.on('RtsPga2', this.handleRtsPga2.bind(this));
    TREM.variable.events.on('RtsPga1', this.handleRtsPga1.bind(this));
    TREM.variable.events.on('RtsShindo2', this.handleRtsShindo2.bind(this));
    TREM.variable.events.on('RtsShindo1', this.handleRtsShindo1.bind(this));
    TREM.variable.events.on('RtsShindo0', this.handleRtsShindo0.bind(this));
    TREM.variable.events.on('ReportRelease', this.handleReportRelease.bind(this));
    TREM.variable.events.on('IntensityRelease', this.handleIntensityRelease.bind(this));
    TREM.variable.events.on('LpgmRelease', this.handleLpgmRelease.bind(this));
    TREM.variable.events.on('IntensityUpdate', this.handleIntensityUpdate.bind(this));
    TREM.variable.events.on('TsunamiRelease', this.handleTsunamiRelease.bind(this));
    TREM.variable.events.on('EewNewAreaAlert', this.handleEewNewAreaAlert.bind(this));
  }

  handleEewRelease(ans) {
    if (!TREM.constant.SHOW_TREM_EEW && ans.data.author == 'trem') {
      return;
    }

    if (ans.data.status == 1) {
      if (this.config['check-box']['sound-effects-EEW2']) {
        this.audioQueues.eew.add(TREM.constant.AUDIO.ALERT, this.priorityRules.eew);
      }
    }
    else {
      if (this.config['check-box']['sound-effects-EEW']) {
        this.audioQueues.eew.add(TREM.constant.AUDIO.EEW, this.priorityRules.eew);
      }
    }

    this.ttsCache[ans.data.id] = {
      last: { loc: '', i: -1 },
      now: { loc: ans.data.eq.loc, i: ans.data.eq.max },
    };

    const notification = new Notification(`${(ans.data.status == 1) ? '🚨 緊急地震速報' : '⚠️ 地震速報'} ${ans.data.serial}報`, {
      body: `${formatTimestamp(ans.data.eq.time)} 最大預估${intensity_list[ans.data.eq.max]}\n${ans.data.eq.loc} M${ans.data.eq.mag} ${ans.data.eq.depth}km`,
      icon: '../TREM.ico',
    });

    notification.onclick = () => {
      win.show();
    };
  }

  handleEewAlert(ans) {
    if (!TREM.constant.SHOW_TREM_EEW && ans.data.author == 'trem') {
      return;
    }
    if (this.config['check-box']['sound-effects-EEW2']) {
      this.audioQueues.eew.add(TREM.constant.AUDIO.ALERT, this.priorityRules.eew);
    }
  }

  handleEewUpdate(ans) {
    if (!TREM.constant.SHOW_TREM_EEW && ans.data.author == 'trem') {
      return;
    }
    this.audioQueues.update.clear();
    if (this.config['check-box']['sound-effects-Update']) {
      this.audioQueues.update.add(TREM.constant.AUDIO.UPDATE);
    }

    this.ttsCache[ans.data.id].now.loc = ans.data.eq.loc;
    this.ttsCache[ans.data.id].now.i = ans.data.eq.max;

    const notification = new Notification(`${(ans.data.status == 1) ? '🚨 緊急地震速報' : '⚠️ 地震速報'} ${ans.data.serial}報`, {
      body: `${formatTimestamp(ans.data.eq.time)} 最大預估${intensity_list[ans.data.eq.max]}\n${ans.data.eq.loc} M${ans.data.eq.mag} ${ans.data.eq.depth}km`,
      icon: '../TREM.ico',
    });

    notification.onclick = () => {
      win.show();
    };
  }

  handleEewEnd(ans) {
    delete this.ttsCache[ans.data.id];
  }

  handleRtsPga2() {
    if (this.config['check-box']['sound-effects-PGA2']) {
      this.audioQueues.pga.add(TREM.constant.AUDIO.PGA2, this.priorityRules.pga);
    }
  }

  handleRtsPga1() {
    if (this.config['check-box']['sound-effects-PGA1']) {
      this.audioQueues.pga.add(TREM.constant.AUDIO.PGA1, this.priorityRules.pga);
    }
  }

  handleRtsShindo2() {
    if (this.config['check-box']['sound-effects-Shindo2']) {
      this.audioQueues.shindo.add(TREM.constant.AUDIO.SHINDO2, this.priorityRules.shindo);
    }

    const notification = new Notification(`🟥 強震檢測 [${formatTimestamp(now())}]`, {
      body: `請注意今後的資訊。`,
      icon: '../TREM.ico',
    });

    notification.onclick = () => {
      win.show();
    };
  }

  handleRtsShindo1() {
    if (this.config['check-box']['sound-effects-Shindo1']) {
      this.audioQueues.shindo.add(TREM.constant.AUDIO.SHINDO1, this.priorityRules.shindo);
    }

    const notification = new Notification(`🟧 震動檢測 [${formatTimestamp(now())}]`, {
      body: `請注意今後的資訊。`,
      icon: '../TREM.ico',
    });

    notification.onclick = () => {
      win.show();
    };
  }

  handleRtsShindo0() {
    if (this.config['check-box']['sound-effects-Shindo0']) {
      this.audioQueues.shindo.add(TREM.constant.AUDIO.SHINDO0);
    }

    const notification = new Notification(`🟩 弱反應 [${formatTimestamp(now())}]`, {
      body: `請注意今後的資訊。`,
      icon: '../TREM.ico',
    });

    notification.onclick = () => {
      win.show();
    };
  }

  handleReportRelease(ans) {
    if (this.config['check-box']['sound-effects-Report']) {
      TREM.constant.AUDIO.REPORT.play();
    }
    let maxIntensity = 0;
    Object.values(ans.data.list).forEach((county) => {
      if (county.int > maxIntensity) {
        maxIntensity = county.int;
      }
    });

    const maxIntensityText = int_to_string(maxIntensity);
    const time = formatToChineseTime(ans.data.time);
    const location = ans.data.loc.match(/位於(.+?)(?=\))/)[1];
    const notificationText = [
      `${time.replace('點', ':').replace('分', '')}`,
      `${location}發生地震`,
      `震源深度${ans.data.depth}公里`,
      `地震規模M${ans.data.mag.toFixed(1)}`,
    ].join('，');

    const countyWithMaxIntensity = Object.entries(ans.data.list).find(([, data]) => data.int === maxIntensity)[0];
    const id = ans.data.id.split('-')[0];

    const notification = new Notification(`🔔 地震報告 [${(id.includes('000')) ? '小區域有感地震' : id}]`, {
      body: notificationText + `，${countyWithMaxIntensity}觀測到最大震度${maxIntensityText}。`,
      icon: '../TREM.ico',
    });

    notification.onclick = () => {
      win.show();
    };

    let ttsText = [
      '地震報告',
      formatToChineseTime(ans.data.time),
      `發生最大震度 ${maxIntensityText} 地震`,
      `震央位於 ${location}`,
      `震央深度為 ${ans.data.depth}公里`,
      `地震規模為 ${ans.data.mag.toFixed(1)}`,
    ].join('，');

    const intensityStations = {
      9: [], 8: [], 7: [], 6: [],
      5: [], 4: [], 3: [], 2: [],
      1: [],
    };

    Object.entries(ans.data.list).forEach(([countyName, countyData]) => {
      Object.entries(countyData.town).forEach(([townName, townData]) => {
        intensityStations[townData.int].push(`${countyName}${townName}`);
      });
    });

    let count = 0;
    for (let intensity = 9; intensity >= 1; intensity--) {
      if (!intensityStations[intensity].length) {
        continue;
      }

      const stationText = intensityStations[intensity].join('，');

      if (count === 0) {
        ttsText += `，這次地震，最大震度 ${int_to_string(intensity)} 地區 ${stationText}`;
      }
      else if (count === 1) {
        ttsText += `，此外，震度 ${int_to_string(intensity)} 地區 ${stationText}`;
      }
      else {
        ttsText += `，震度 ${int_to_string(intensity)} 地區 ${stationText}`;
        break;
      }
      count++;
    }

    const speechText = ttsText
      .replace('2.', '二點')
      .replaceAll('.2', '點二')
      .replaceAll('三地門', '三弟門')
      .replaceAll('.', '點')
      .replaceAll('為', '圍');

    TREM.variable.speech.speak({ text: speechText });
  }

  handleLpgmRelease(ans) {
    if (this.config['check-box']['sound-effects-PAlert']) {
      TREM.constant.AUDIO.INTENSITY.play();
    }

    const time = formatToChineseTime(ans.data.id);

    let maxIntensity = 0;
    let maxCity = '';

    const intensityStations = {
      4: [], 3: [], 2: [], 1: [],
    };
    const locationMaxIntensity = new Map();

    ans.data.list.forEach((station) => {
      if (!station.lpgm) {
        return;
      }

      const station_info = TREM.variable.station[station.id];
      if (!station_info) {
        return;
      }

      const station_location = station_info.info.at(-1);
      if (!station_location) {
        return;
      }

      const loc = search_loc_name(station_location.code);
      if (!loc) {
        return;
      }

      if (station.lpgm > maxIntensity) {
        maxIntensity = station.lpgm;
        maxCity = loc.city;
      }

      const locationKey = `${loc.city}${loc.town}`;
      const intensity = station.lpgm;

      if (locationMaxIntensity.has(locationKey)) {
        if (intensity > locationMaxIntensity.get(locationKey)) {
          const oldIntensity = locationMaxIntensity.get(locationKey);
          intensityStations[oldIntensity] = intensityStations[oldIntensity]
            .filter((loc) => loc !== locationKey);

          if (intensity in intensityStations) {
            intensityStations[intensity].push(locationKey);
            locationMaxIntensity.set(locationKey, intensity);
          }
        }
      }
      else {
        if (intensity in intensityStations) {
          intensityStations[intensity].push(locationKey);
          locationMaxIntensity.set(locationKey, intensity);
        }
      }
    });

    const notification = new Notification('🔔 長週期地震動', {
      body: `${time.replace('點', ':').replace('分', '')}，${maxCity}觀測到最大長週期地震動階級${maxIntensity}。`,
      icon: '../TREM.ico',
    });

    notification.onclick = () => {
      win.show();
    };

    let ttsText = [
      '長週期地震動觀測資訊',
      formatToChineseTime(ans.data.id),
      `${maxCity}觀測到最大長週期地震動階級${maxIntensity}`,
    ].join('，');

    let count = 0;
    for (let intensity = 4; intensity >= 1; intensity--) {
      if (!intensityStations[intensity].length) {
        continue;
      }

      const stationText = intensityStations[intensity].join('，');

      if (count === 0) {
        ttsText += `，這次地震，最大長週期地震動階級 ${intensity} 地區 ${stationText}`;
      }
      else if (count === 1) {
        ttsText += `，此外，長週期地震動階級 ${intensity} 地區 ${stationText}`;
      }
      else {
        ttsText += `，長週期地震動階級 ${intensity} 地區 ${stationText}`;
        break;
      }
      count++;
    }

    const speechText = ttsText
      .replace('2.', '二點')
      .replaceAll('.2', '點二')
      .replaceAll('三地門', '三弟門')
      .replaceAll('.', '點')
      .replaceAll('為', '圍');

    TREM.variable.speech.speak({ text: speechText });
  }

  handleIntensityRelease(ans) {
    if (this.config['check-box']['sound-effects-PAlert']) {
      TREM.constant.AUDIO.INTENSITY.play();
    }

    const city_intensity_list = findMaxIntensityCity(ans.data.area);

    if (TREM.variable.cache.intensity.max < ans.data.max) {
      TREM.variable.speech.speak({ text: `震度速報，震度${int_to_string(city_intensity_list.intensity).replace('級', '')}，${city_intensity_list.cities.join('、')}`, queue: true });
      const notification = new Notification(`📨 震度速報 [${formatTimestamp(ans.data.id)}]`, {
        body: `震度${int_to_string(city_intensity_list.intensity).replace('級', '')} ${city_intensity_list.cities.join('、')}`,
        icon: '../TREM.ico',
      });

      notification.onclick = () => {
        win.show();
      };
    }
  }

  handleIntensityUpdate(ans) {
    this.handleIntensityRelease(ans);
  }

  handleTsunamiRelease() {
    TREM.constant.AUDIO.TSUNAMI.play();
  }

  handleEewNewAreaAlert(ans) {
    if (!TREM.variable.tts) {
      return;
    }
    if (TREM.variable.speech.speaking()) {
      TREM.variable.speech.cancel();
    }
    this.ttsEewAlertLock = true;
    TREM.variable.speech.speak({
      text: `緊急地震速報，${ans.data.city_alert_list.join('、')}，慎防強烈搖晃`,
      queue: false,
      listeners: {
        onend: () => {
          this.ttsEewAlertLock = false;
        },
      },
    });
  }

  initTtsInterval() {
    if (TREM.variable.tts) {
      setInterval(() => {
        if (this.ttsEewAlertLock) {
          return;
        }
        for (const id of Object.keys(this.ttsCache)) {
          if (this.ttsCache[id].now.i > this.ttsCache[id].last.i) {
            this.ttsCache[id].last.loc = this.ttsCache[id].now.loc;
            TREM.variable.speech.speak({ text: `${this.ttsCache[id].last.loc}發生地震`, queue: true });

            this.ttsCache[id].last.i = this.ttsCache[id].now.i;
            TREM.variable.speech.speak({
              text: `預估最大震度${(!this.ttsCache[id].last.i) ? '不明' : intensity_list[this.ttsCache[id].last.i].replace('⁻', '弱').replace('⁺', '強')}`,
              queue: true,
            });
          }
        }
      }, 3000);
    }
  }
}

TREM.class.AudioManager = AudioManager;

const audioManager = AudioManager.getInstance();
module.exports = audioManager;
