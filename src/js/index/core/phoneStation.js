const TREM = require('../constant');
const { ipcRenderer } = require('electron');
const { processEEWData } = require('../data/data');
const now = require('../utils/ntp');
const Config = require('../../core/config');
const EEWCalculator = require('../utils/eewCalculator');
const { nearest_loc_code, search_loc_name } = require('../utils/utils');

// 手機自己反查地名是用瀏覽器打 Nominatim（外部地圖服務），GPS 座標在行政區交界附近時
// 每次反查結果可能飄動（比如「樹林區」「三峽區」交替出現），跟 App 自己用同一套
// region.json 做最近測站比對算出來的地名對不上。這裡一律用最近的 GPS 座標比對
// （跟 injectPhoneStations 用同一套 nearest_loc_code），不採信手機端送上來的地名，
// 確保同一個座標永遠對應到同一個地名，跟其他真實測站的顯示邏輯一致。
function resolveLocationName(lat, lng) {
  const code = nearest_loc_code(lat, lng);
  if (code == null) {
    return '手機測站偵測';
  }
  const loc = search_loc_name(code);
  return loc ? `${loc.city}${loc.town}` : '手機測站偵測';
}

// 不傳 timeTable：這裡只用 pgaToFloat/pgaToIntensity（gal 換算震度），
// 不用到 psWaveDist 等需要走時表的方法。
const calculator = new EEWCalculator();

// 設定頁的「顯示解析度警報」勾選框（early-warning-trem-eew）原本沒有真的接到
// TREM.constant.SHOW_TREM_EEW 這個顯示開關上（那個常數是寫死的 false），導致這個
// 設定勾了也沒作用，連帶手機的偽 EEW（也是用 author:'trem'）永遠不會顯示。這裡補上
// 這條線，讓它真的跟著使用者設定走，開機時讀一次，設定變更時（main.js 轉發的
// refresh-config）重新讀一次。
function syncShowTremEew() {
  TREM.constant.SHOW_TREM_EEW = !!Config.getInstance().getConfig(true)['check-box']?.['early-warning-trem-eew'];
}
syncShowTremEew();
ipcRenderer.on('refresh-config', syncShowTremEew);

// 手機自己算的 intensityLabel/intensityValue 只拿來當它自己畫面上的參考值，
// 送進 TREM 主系統這邊一律用 app 既有、跟官方測站相同的 PGA 換算公式
// （EEWCalculator.pgaToFloat/pgaToIntensity）重新算一次，兩邊用同一套「真實推算
// 機制」，不會因為手機端自己的公式跟正式系統的公式常數不同而對不起來。
// pgaToFloat 對 pga<=0 會是 -Infinity，待機（沒訊號）時直接給跟官方測站閒置一樣的 -3。
function pgaToColorValue(accel) {
  return accel > 0 ? calculator.pgaToFloat(accel) : -3;
}
function pgaToBadgeIndex(accel) {
  return accel > 0 ? calculator.pgaToIntensity(accel) : 0;
}

const RETRIGGER_COOLDOWN_MS = 15000; // 15 秒

// ---- 手機測站真的併進官方測站同一份資料 ----
// 手機沒有官方行政區代碼，用經緯度借最近的鄉鎮代碼；key 加 'phone-' 前綴，
// 避免萬一跟真實測站的純數字 ID 撞號（真實測站 ID 都是數字字串）。
// 這個監聽器要搶在 rts.js 自己的 'DataRts' 處理邏輯之前跑（require.js 裡刻意讓
// core/phoneStation 排在 core/rts 前面，EventEmitter 監聽器照註冊順序同步呼叫），
// 把手機資料寫進 ans.data.station / TREM.variable.station 之後，rts.js 那一大段
// 既有的測站處理迴圈（觸發判斷、RtsPga/RtsShindo 音效、面板數字、地圖圖層）就會
// 把手機當成普通測站一起處理，不用另外維護一套平行邏輯。
function injectPhoneStations(ans) {
  // TREM.variable.station（真實測站中繼資料表）是 resource.js 非同步抓回來的，
  // App 剛啟動、第一筆 DataRts 進來時可能還是 null——rts.js 自己的處理邏輯也是
  // 用同一個條件擋在最前面，這裡跟著一致，不然 Object.keys(null) 會直接噴例外。
  if (!ans?.data?.station || !TREM.variable.station) {
    return;
  }

  const activeKeys = new Set();
  const todayIso = new Date().toISOString().slice(0, 10);

  for (const station of TREM.variable.data.phoneStations) {
    if (typeof station.lat !== 'number' || typeof station.lng !== 'number') {
      continue;
    }

    const code = nearest_loc_code(station.lat, station.lng);
    if (code == null) {
      continue;
    }

    const key = `phone-${station.deviceId}`;
    activeKeys.add(key);

    TREM.variable.station[key] = {
      net: 'Phone',
      info: [{ code, lat: station.lat, lon: station.lng, time: todayIso }],
      work: true,
    };

    const pga = station.accel > 0 ? station.accel : 0;
    const intensityValue = pga > 0 ? calculator.pgaToFloat(pga) : -3;

    ans.data.station[key] = {
      pga,
      pgv: 0,
      i: intensityValue,
      I: intensityValue,
      alert: !!(station.trigger && intensityValue > EEW_TRIGGER_THRESHOLD),
    };
  }

  // 手機斷線/逾時後，伺服器那邊已經不會再回報它，這裡把殘留的靜態測站資料也清掉，
  // 不然 TREM.variable.station 會一直留著永遠用不到的殭屍測站。
  for (const key of Object.keys(TREM.variable.station)) {
    if (key.startsWith('phone-') && !activeKeys.has(key)) {
      delete TREM.variable.station[key];
    }
  }
}
TREM.variable.events.on('DataRts', injectPhoneStations);

// ---- 手機測站晃動達門檻時的 EEW 資訊框 ----
// EEW 跟逐測站的 rts 資料是不同的東西：真正的官方/trem EEW 是伺服器端彙整全網
// 測站後算出來的，單一使用者的手機沒辦法「送」一個真的 EEW 回伺服器讓它重新計算，
// 所以這裡沒有對應的「官方方法」可以直接塞資料進去，維持原本客戶端本地合成的
// 方式：跟官方測站一樣用 app 既有的「trem 型 EEW」機制（跟真正 CWA 官方 EEW 分開
// 處理、預設隱藏、要使用者自己開「顯示解析度警報」才會顯示），author 用 'trem'、
// mag 用 1（沿用既有的 NSSPE 慣例：代表這不是有規模估算的正式警報，只是偵測到晃動）。
const phoneEewState = {};
const EEW_TRIGGER_THRESHOLD = 1; // 跟 RtsShindo1（震動檢測）同門檻，弱反應不足以跳 EEW 框
// 每一個 EEW id 在 eew.js 都會各自建立自己的一組地圖圖層/來源，而且有一個 100ms
// 的計時器會對「每一個」目前存在的 EEW 算一次波形圓（256 個點的多邊形），這個成本
// 是設計給「同時最多幾個真實地震事件」用的。如果每一支觸發中的手機都各自建一個
// EEW，觸發手機一多（比如上百支同時搖），瞬間變成上百組圖層 + 上百份波形圓計算，
// 每秒跑 10 次，實測會把畫面卡死到「無回應」。改成只保留震度最高的少數幾筆當
// EEW，不管同時有幾支手機在動，都不會讓 EEW 數量爆炸。
const MAX_PHONE_EEW = 3;

function checkPhoneEew(list) {
  const nowMs = Date.now();

  const candidates = list
    .map((station) => ({
      station,
      intensityValue: station.accel > 0 ? pgaToColorValue(station.accel) : -Infinity,
    }))
    .filter(({ station, intensityValue }) => station.trigger
      && typeof station.lat === 'number' && typeof station.lng === 'number'
      && intensityValue > EEW_TRIGGER_THRESHOLD)
    .sort((a, b) => b.intensityValue - a.intensityValue)
    .slice(0, MAX_PHONE_EEW);

  const activeIds = new Set();

  for (const { station, intensityValue } of candidates) {
    activeIds.add(station.deviceId);

    if (!phoneEewState[station.deviceId]) {
      phoneEewState[station.deviceId] = { serial: 0, lastActiveAt: 0 };
    }
    const state = phoneEewState[station.deviceId];
    state.lastActiveAt = nowMs;
    state.serial += 1;

    const status = intensityValue > 3 ? 1 : 0;

    processEEWData([{
      id: `phone-eew-${station.deviceId}`,
      author: 'trem',
      serial: state.serial,
      status,
      final: false,
      rts: !status,
      eq: {
        lat: station.lat,
        lon: station.lng,
        depth: 5,
        loc: resolveLocationName(station.lat, station.lng),
        mag: 1,
        max: pgaToBadgeIndex(station.accel),
        time: now(),
      },
    }]);
  }

  // 不在候選名單裡的（包含被擠出前 MAX_PHONE_EEW 名的），照原本的冷卻時間結束，
  // 不要一被擠出榜單就立刻消失、又馬上因為震度回升重新進榜，導致資訊框一直閃。
  for (const deviceId of Object.keys(phoneEewState)) {
    if (activeIds.has(deviceId)) {
      continue;
    }
    if (nowMs - phoneEewState[deviceId].lastActiveAt >= RETRIGGER_COOLDOWN_MS) {
      endPhoneEew(deviceId);
    }
  }
}

// 獨立清理，不依賴「其他裝置有沒有繼續回報來推進 tick」——手機背景分頁常被瀏覽器
// 節流甚至暫停，如果清理邏輯只在別的裝置觸發 IPC 時才檢查，殘留的假 EEW 資訊框
// 可能一直卡在畫面上收不掉。改用真正的計時器，固定每幾秒自己檢查一次。
function cleanupIdlePhoneEew() {
  const nowMs = Date.now();
  for (const deviceId of Object.keys(phoneEewState)) {
    if (nowMs - phoneEewState[deviceId].lastActiveAt >= RETRIGGER_COOLDOWN_MS) {
      endPhoneEew(deviceId);
    }
  }
}
setInterval(cleanupIdlePhoneEew, 3000);

function endPhoneEew(deviceId) {
  const id = `phone-eew-${deviceId}`;
  const index = TREM.variable.data.eew.findIndex((item) => item.id === id);

  if (index !== -1) {
    const data = TREM.variable.data.eew[index];
    TREM.variable.data.eew.splice(index, 1);
    TREM.variable.events.emit('EewEnd', {
      info: { type: TREM.variable.play_mode },
      data: { ...data, EewEnd: true },
    });
  }

  // 同步清掉 processEEWData 自己的序號快取，不然下次同一支手機重新觸發時，
  // 快取裡還留著較高的序號，會被誤判成「舊資料」而略過，畫面不會更新。
  delete TREM.variable.cache.eew_last[id];
  delete phoneEewState[deviceId];
}

ipcRenderer.on('phone-stations-update', (event, list) => {
  TREM.variable.data.phoneStations = list || [];
  checkPhoneEew(TREM.variable.data.phoneStations);
});
