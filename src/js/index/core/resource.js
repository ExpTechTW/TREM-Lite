const TREM = require('../constant');

const fetchData = require('../../core/utils/fetch');

get_station_info();

setInterval(get_station_info, 600000);

async function get_station_info() {
  const url = TREM.constant.URL.API[Math.floor(Math.random() * TREM.constant.URL.API.length)];
  const ans = await fetchData(`https://${url}/api/v1/trem/station`, TREM.constant.HTTP_TIMEOUT.RESOURCE);

  if (ans && ans.ok) {
    TREM.variable.station = await ans.json();
  }
  else {
    setTimeout(get_station_info, 3000);
  }
}
