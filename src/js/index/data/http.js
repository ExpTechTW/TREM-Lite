const TREM = require('../constant');
const fetchData = require('../../core/utils/fetch');

let activeRequests = [];

function abortAll() {
  activeRequests.forEach((fetcher) => fetcher.controller.abort());
  activeRequests = [];
}

let requestCounter = 0;

async function getData(time) {
  time = Math.round(time / 1000);
  requestCounter++;
  const shouldFetchLPGM = requestCounter % 10 === 0;
  const shouldFetchIntensity = requestCounter % 5 === 0;

  const url = (time)
    ? TREM.constant.URL.REPLAY[Math.floor(Math.random() * TREM.constant.URL.REPLAY.length)]
    : TREM.constant.URL.LB[Math.floor(Math.random() * TREM.constant.URL.LB.length)];

  const rts_req = (TREM.variable.play_mode == 1)
    ? null
    : fetchData.withController(
      `https://${url}/api/v2/trem/rts${(time) ? `/${time}` : ''}`,
      TREM.constant.HTTP_TIMEOUT.RTS,
    );
  const eew_req = (TREM.variable.play_mode == 1)
    ? null
    : fetchData.withController(
      `https://${url}/api/v2/eq/eew${(time) ? `/${time}` : ''}`,
      TREM.constant.HTTP_TIMEOUT.EEW,
    );

  const activeReqs = [rts_req, eew_req];
  let intensity_req, lpgm_req;

  if (shouldFetchIntensity) {
    intensity_req = fetchData.withController(
      `https://${TREM.constant.URL.API[0]}/api/v2/trem/intensity${(time) ? `/${time}` : ''}`,
      TREM.constant.HTTP_TIMEOUT.INTENSITY,
    );
    activeReqs.push(intensity_req);
  }

  if (shouldFetchLPGM) {
    lpgm_req = fetchData.withController(
      `https://${TREM.constant.URL.API[0]}/api/v2/trem/lpgm${(time) ? `/${time}` : ''}`,
      TREM.constant.HTTP_TIMEOUT.LPGM,
    );
    activeReqs.push(lpgm_req);
  }

  activeRequests.push(...activeReqs);

  try {
    const responses = await Promise.all(activeReqs.map((req) => !req ? null : req.execute()));

    let rts = null, eew = null, intensity = null, lpgm = null;

    if (responses[0]?.ok) {
      rts = await responses[0].json();
    }
    if (responses[1]?.ok) {
      eew = await responses[1].json();
    }

    if (shouldFetchIntensity && responses[2]?.ok) {
      intensity = await responses[2].json();
    }

    if (shouldFetchLPGM && responses[responses.length - 1]?.ok) {
      lpgm = await responses[responses.length - 1].json();
    }

    return { rts, eew, intensity, lpgm };
  }
  finally {
    activeRequests = activeRequests.filter((req) => !activeReqs.includes(req));
  }
}

module.exports = getData;
module.exports.abortAll = abortAll;
