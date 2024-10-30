const TREM = require("../constant");

const fetchData = require("../utils/fetch");

(async () => {
  const url = TREM.constant.URL.API[Math.floor(Math.random() * TREM.constant.URL.API.length)];
  const ans = await fetchData(`https://${url}/api/v1/trem/station`, TREM.constant.HTTP_TIMEOUT.RESOURCE);

  if (ans) TREM.variable.station = await ans.json();

  // 錯誤彈窗
})();