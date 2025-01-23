const TREM = require('../constant');

const { formatTime } = require('../utils/utils');
const now = require('../utils/ntp');
const refresh_cross = require('./cross');
const refresh_box = require('./box');
const fetchData = require('../../core/utils/fetch');

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
  const t = Date.now();
  const url = TREM.constant.URL.LB[Math.floor(Math.random() * TREM.constant.URL.LB.length)];
  const ans = await fetchData(`https://${url}/ntp`, TREM.constant.HTTP_TIMEOUT.NTP);

  if (ans && ans.ok) {
    TREM.variable.cache.time.syncedTime = await ans.json();
    TREM.variable.cache.time.lastSync = Date.now() - (Date.now() - t) - 1000;
  }
  else {
    setTimeout(get_ntp, 3000);
  }
}

get_ntp();
setInterval(get_ntp, 60000);
