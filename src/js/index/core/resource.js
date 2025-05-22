const TREM = require('../constant');

const fetchData = require('../../core/utils/fetch');

get_station_info();

setInterval(get_station_info, 600000);

async function get_station_info() {
  TREM.variable.station = require('../../../resource/data/station.json');
  localStorage.setItem('cache.station', JSON.stringify(TREM.variable.station));
  return;
  const url = TREM.constant.URL.API[Math.floor(Math.random() * TREM.constant.URL.API.length)];
  const ans = await fetchData(`https://${url}/api/v1/trem/station`, TREM.constant.HTTP_TIMEOUT.RESOURCE);

  if (ans && ans.ok) {
    TREM.variable.station = await ans.json();
    localStorage.setItem('cache.station', JSON.stringify(TREM.variable.station));
  }
  else {
    setTimeout(get_station_info, 3000);
  }
}
