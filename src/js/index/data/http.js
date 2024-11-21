const TREM = require('../constant');

const fetchData = require('../../core/utils/fetch');

module.exports = async (time) => {
  const url = (time) ? TREM.constant.URL.REPLAY[Math.floor(Math.random() * TREM.constant.URL.REPLAY.length)] : TREM.constant.URL.LB[Math.floor(Math.random() * TREM.constant.URL.LB.length)];
  const rts_ans = await fetchData(`https://${url}/api/v1/trem/rts${(time) ? `/${time}` : ''}`, TREM.constant.HTTP_TIMEOUT.RTS);
  const eew_ans = await fetchData(`https://${url}/api/v1/eq/eew${(time) ? `/${time}` : ''}`, TREM.constant.HTTP_TIMEOUT.EEW);
  const intensity_ans = await fetchData(`https://${TREM.constant.URL.API[1]}/api/v1/trem/intensity${(time) ? `/${time}` : ''}`, TREM.constant.HTTP_TIMEOUT.INTENSITY);
  time = 1732199147000;
  const lpgm_ans = await fetchData(`https://${TREM.constant.URL.API[1]}/api/v1/trem/lpgm${(time) ? `/${time}` : ''}`, TREM.constant.HTTP_TIMEOUT.INTENSITY);

  let rts = null, eew = null, intensity = null, lpgm = null;

  if (rts_ans && rts_ans.ok) {
    rts = await rts_ans.json();
  }

  if (eew_ans && eew_ans.ok) {
    eew = await eew_ans.json();
  }

  if (intensity_ans && intensity_ans.ok) {
    intensity = await intensity_ans.json();
  }

  if (lpgm_ans && lpgm_ans.ok) {
    lpgm = await lpgm_ans.json();
  }

  return { rts, eew, intensity, lpgm };
};
