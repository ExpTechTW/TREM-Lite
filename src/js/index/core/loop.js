const TREM = require('../constant');

const { formatTime } = require('../utils/utils');
const now = require('../utils/ntp');
const refresh_cross = require('./cross');
const refresh_box = require('./box');
const { NtpTimeSync } = require('ntp-time-sync');

const time = document.getElementById('time');
const warning_box_internet = document.getElementById('warning-box-internet');

let flash = false;

setInterval(() => {
  if (TREM.variable.play_mode == 2 || TREM.variable.play_mode == 3) {
    if (!TREM.variable.replay.dev) {
      time.className = 'time-replay';
    }
    else {
      time.className = 'time-normal';
    }
    time.textContent = formatTime(now());

    if (!warning_box_internet.classList.contains('hide')) {
      warning_box_internet.classList.add('hide');
    }
  }
  else if ((Date.now() - TREM.variable.cache.last_data_time) > TREM.constant.LAST_DATA_TIMEOUT_ERROR) {
    time.className = 'time-error';

    if (warning_box_internet.classList.contains('hide')) {
      warning_box_internet.classList.remove('hide');
    }
  }
  else {
    time.className = 'time-normal';
    time.textContent = formatTime(now());

    if (!warning_box_internet.classList.contains('hide')) {
      warning_box_internet.classList.add('hide');
    }
  }
}, 1000);

TREM.variable.events.on('MapLoad', () => {
  setInterval(() => {
    flash = !flash;
    refresh_cross(flash);
    refresh_box(flash);
  }, 500);
});

async function get_ntp() {
  try {
    const timeSync = NtpTimeSync.getInstance({
      servers: ['time.exptech.com.tw'],
      sampleCount: 4,
      replyTimeout: 3000,
    });

    const result = await timeSync.getTime(true);

    TREM.variable.cache.time.syncedTime = result.now.getTime();
    TREM.variable.cache.time.lastSync = Date.now();

    console.log(`NTP 同步完成，偏移量: ${result.offset.toFixed(2)} ms`);
  }
  catch (error) {
    console.error('NTP 同步錯誤:', error.message);
  }
}

get_ntp();
setInterval(get_ntp, 60000);
