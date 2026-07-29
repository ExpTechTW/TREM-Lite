const TREM = require('../constant');
const { ipcRenderer } = require('electron');
const Config = require('../../core/config');
const EEWCalculator = require('../utils/eewCalculator');
const { nearest_loc_code } = require('../utils/utils');
const { RELAY_URL, RELAY_KEY } = require('../../core/phoneRelayConfig');

// 全球手機測站中繼網路（原型版）：把「別人」回報的手機測站也拉進來顯示在地圖上，
// 同時把「自己」連進本機手機伺服器的手機測站廣播出去，讓別人也看得到。跟
// phoneStation.js（只處理自己電腦本機連的手機）是分開的兩個資料來源，key 用
// 'relay-' 前綴避免撞號。中繼伺服器本身是原型（記憶體暫存、非強驗證），細節見
// relay-server/api/relay.js 開頭註解。
const POLL_INTERVAL_MS = 3000;
const BROADCAST_INTERVAL_MS = 3000;

const calculator = new EEWCalculator();

let relayEnabled = false;
function syncRelayEnabled() {
  relayEnabled = !!Config.getInstance().getConfig(true)['check-box']?.['phone-relay-enabled'];
}
syncRelayEnabled();
ipcRenderer.on('refresh-config', syncRelayEnabled);

// ---- 拉取別人回報的手機測站 ----
async function pollRelay() {
  if (!relayEnabled) {
    return;
  }
  try {
    const res = await fetch(RELAY_URL);
    if (!res.ok) {
      return;
    }
    const body = await res.json();
    TREM.variable.data.relayStations = body?.stations || [];
  }
  catch { /* 這輪拉取失敗，等下一輪再試，不用特別處理 */ }
}
setInterval(pollRelay, POLL_INTERVAL_MS);

// ---- 把中繼拉回來的測站併進地圖（跟 phoneStation.js 對本機手機測站的作法一致）----
function injectRelayStations(ans) {
  if (!relayEnabled || !ans?.data?.station || !TREM.variable.station) {
    return;
  }

  // 自己廣播出去的測站可能被中繼原樣回應，不能再拉回來一次，不然會跟本機那份
  // （key 是 phone-<deviceId>）重複顯示成兩個測站。
  const localIds = new Set((TREM.variable.data.phoneStations || []).map((station) => station.deviceId));

  const activeKeys = new Set();
  const todayIso = new Date().toISOString().slice(0, 10);

  for (const station of TREM.variable.data.relayStations || []) {
    if (localIds.has(station.id)) {
      continue;
    }
    if (typeof station.lat !== 'number' || typeof station.lng !== 'number') {
      continue;
    }

    const code = nearest_loc_code(station.lat, station.lng);
    if (code == null) {
      continue;
    }

    const key = `relay-${station.id}`;
    activeKeys.add(key);

    TREM.variable.station[key] = {
      net: 'Phone',
      info: [{ code, lat: station.lat, lon: station.lng, time: todayIso }],
      work: true,
    };

    const intensityValue = typeof station.intensityValue === 'number' ? station.intensityValue : -3;
    ans.data.station[key] = {
      pga: station.accel > 0 ? station.accel : 0,
      pgv: 0,
      i: intensityValue,
      I: intensityValue,
      alert: !!station.trigger && intensityValue > 1,
    };
  }

  for (const key of Object.keys(TREM.variable.station)) {
    if (key.startsWith('relay-') && !activeKeys.has(key)) {
      delete TREM.variable.station[key];
    }
  }
}
TREM.variable.events.on('DataRts', injectRelayStations);

// ---- 把自己本機連的手機測站廣播出去，讓其他 TREM-Lite 使用者也看得到 ----
async function broadcastLocalStations() {
  if (!relayEnabled) {
    return;
  }
  const list = TREM.variable.data.phoneStations || [];
  for (const station of list) {
    if (typeof station.lat !== 'number' || typeof station.lng !== 'number') {
      continue;
    }
    const pga = station.accel > 0 ? station.accel : 0;
    try {
      await fetch(RELAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Relay-Key': RELAY_KEY },
        body: JSON.stringify({
          id: station.deviceId,
          lat: station.lat,
          lng: station.lng,
          accel: pga,
          intensityValue: pga > 0 ? calculator.pgaToFloat(pga) : -3,
          trigger: !!station.trigger,
        }),
      });
    }
    catch { /* 這輪送出失敗，等下一輪再試 */ }
  }
}
setInterval(broadcastLocalStations, BROADCAST_INTERVAL_MS);
