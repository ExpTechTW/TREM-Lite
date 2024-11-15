const TREM = require('../constant');

const fetchData = require('../../core/utils/fetch');

(async () => {
  const url = TREM.constant.URL.API[Math.floor(Math.random() * TREM.constant.URL.API.length)];
  const ans = await fetchData(`https://${url}/api/v1/trem/station`, TREM.constant.HTTP_TIMEOUT.RESOURCE);

  if (ans) {
    TREM.variable.station = await ans.json();
    localStorage.setItem('constant', JSON.stringify(TREM));
  }

  // 錯誤彈窗
})();
