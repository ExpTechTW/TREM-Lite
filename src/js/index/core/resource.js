const TREM = require('../constant');

const fetchData = require('../../core/utils/fetch');

let retryTimeout = null;
const MAX_RETRIES = 5;
let retryCount = 0;

get_station_info();

setInterval(get_station_info, 600000);

async function get_station_info() {
  // 清除之前的重試 timeout
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }

  const url = TREM.constant.URL.API[Math.floor(Math.random() * TREM.constant.URL.API.length)];
  const ans = await fetchData(`https://${url}/api/v1/trem/station`, TREM.constant.HTTP_TIMEOUT.RESOURCE);

  if (ans && ans.ok) {
    TREM.variable.station = await ans.json();
    localStorage.setItem('cache.station', JSON.stringify(TREM.variable.station));
    retryCount = 0;
  }
  else if (retryCount < MAX_RETRIES) {
    retryCount++;
    retryTimeout = setTimeout(get_station_info, 3000 * retryCount);
  }
  else {
    retryCount = 0;
  }
}
