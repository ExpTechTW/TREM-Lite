const TREM = require('../constant');
const fetchData = require('../../core/utils/fetch');

let activeRequests = [];

function abortAll() {
  activeRequests.forEach((fetcher) => fetcher.controller.abort());
  activeRequests = [];
}

async function getData(time) {
  const url = (time) ? TREM.constant.URL.REPLAY[Math.floor(Math.random() * TREM.constant.URL.REPLAY.length)] : TREM.constant.URL.LB[Math.floor(Math.random() * TREM.constant.URL.LB.length)];

  const rts_req = fetchData.withController(`https://${url}/api/v1/trem/rts${(time) ? `/${time}` : ''}`, TREM.constant.HTTP_TIMEOUT.RTS);
  const eew_req = fetchData.withController(`https://${url}/api/v1/eq/eew${(time) ? `/${time}` : ''}`, TREM.constant.HTTP_TIMEOUT.EEW);
  const intensity_req = fetchData.withController(`https://${TREM.constant.URL.API[1]}/api/v1/trem/intensity${(time) ? `/${time}` : ''}`, TREM.constant.HTTP_TIMEOUT.INTENSITY);
  const lpgm_req = fetchData.withController(`https://${TREM.constant.URL.API[1]}/api/v1/trem/lpgm${(time) ? `/${time}` : ''}`, TREM.constant.HTTP_TIMEOUT.LPGM);

  activeRequests.push(rts_req, eew_req, intensity_req, lpgm_req);

  try {
    const [rts_ans, eew_ans, intensity_ans, lpgm_ans] = await Promise.all([
      rts_req.execute(),
      eew_req.execute(),
      intensity_req.execute(),
      lpgm_req.execute(),
    ]);

    let rts = null, eew = null, intensity = null, lpgm = null;

    if (rts_ans?.ok) {
      rts = await rts_ans.json();
    }
    if (eew_ans?.ok) {
      eew = await eew_ans.json();
    }
    if (intensity_ans?.ok) {
      intensity = await intensity_ans.json();
    }
    if (lpgm_ans?.ok) {
      lpgm = await lpgm_ans.json();
    }

    return { rts, eew, intensity, lpgm };
  }
  finally {
    activeRequests = activeRequests.filter((req) => ![rts_req, eew_req, intensity_req, lpgm_req].includes(req));
  }
}

module.exports = getData;
module.exports.abortAll = abortAll;
