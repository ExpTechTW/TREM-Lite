const TREM = require("../constant");

const fetchData = require("../utils/fetch");

module.exports = async (time) => {
  const url = (time) ? TREM.constant.URL.API[Math.floor(Math.random() * TREM.constant.URL.API.length)] : TREM.constant.URL.LB[Math.floor(Math.random() * TREM.constant.URL.LB.length)];
  const rts_ans = await fetchData(`https://${url}/api/v1/trem/rts${(time) ? `/${time}` : ""}`, TREM.constant.HTTP_TIMEOUT.RTS);
  const eew_ans = await fetchData(`https://${url}/api/v1/eq/eew${(time) ? `/${time}` : ""}`, TREM.constant.HTTP_TIMEOUT.EEW);

  let rts = null, eew = null;

  if (rts_ans && rts_ans.ok) rts = await rts_ans.json();
  if (eew_ans && eew_ans.ok) eew = await eew_ans.json();

  return { rts, eew };
};