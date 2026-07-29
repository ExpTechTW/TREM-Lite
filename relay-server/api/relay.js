// TREM-Lite 手機地震儀中繼伺服器（原型版）
//
// 目的：讓任何一台 TREM-Lite 使用者的手機測站資料，廣播給「其他所有」TREM-Lite
// 使用者看到，不再只限定回報者自己那台電腦。
//
// 已知限制（這是先求有、之後再跟 ExpTech 討論要不要併進官方網路的過渡版本）：
// - 狀態存在這個 function 的記憶體裡（模組層級變數），不是真正的資料庫。Vercel
//   Serverless Function 在流量大或跨區域時可能會啟動多個執行個體，各自的記憶體不
//   互通，理論上不同使用者的請求有機會打到不同的執行個體、看到不完全一致的清單；
//   流量小、單區域的情況下實務上多半會一直打到同一個溫執行個體，堪用但不保證。
// - 冷啟動 / 重新部署會讓記憶體清空，所有測站要重新回報一次。
// - X-Relay-Key 是寫死在 TREM-Lite 原始碼裡的共用金鑰，用意只是擋掉隨便路過的
//   掃描器/機器人，不是真正的身分驗證——金鑰本身對任何看得到 App 原始碼的人都不是
//   秘密。要擋惡意使用者故意灌假地震資料，需要更完整的驗證/審核機制，這版先不做。

const STALE_MS = 20000; // 跟本機手機伺服器一致：超過這麼久沒回報就視為離線
const RATE_LIMIT_MS = 200; // 同一個 id 最短回報間隔，防止單一裝置洗流量
const MAX_STATIONS = 500; // 原型版先設一個上限，避免記憶體被灌爆
const RELAY_KEY = process.env.RELAY_KEY || 'trem-lite-phone-relay-v1-proto';

// 模組層級變數：同一個溫執行個體內的多次呼叫會共用這個 Map（見檔案開頭限制說明）。
const stations = new Map();

function cleanup() {
  const now = Date.now();
  for (const [id, s] of stations) {
    if (now - s.lastSeen > STALE_MS) {
      stations.delete(id);
    }
  }
}

function isFiniteNumberInRange(n, min, max) {
  return typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Relay-Key');
}

module.exports = (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  cleanup();

  if (req.method === 'GET') {
    const list = Array.from(stations.entries()).map(([id, s]) => ({
      id,
      lat: s.lat,
      lng: s.lng,
      accel: s.accel,
      intensityValue: s.intensityValue,
      trigger: s.trigger,
    }));
    res.status(200).json({ stations: list });
    return;
  }

  // 寫入類操作（POST / DELETE）都要求帶對的共用金鑰，GET 不用（本來就是要公開廣播給大家看）。
  if (req.headers['x-relay-key'] !== RELAY_KEY) {
    res.status(401).json({ error: 'invalid relay key' });
    return;
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const id = String(body.id || '').slice(0, 128);

    if (!id) {
      res.status(400).json({ error: 'id required' });
      return;
    }
    if (!isFiniteNumberInRange(body.lat, -90, 90) || !isFiniteNumberInRange(body.lng, -180, 180)) {
      res.status(400).json({ error: 'invalid lat/lng' });
      return;
    }

    const existing = stations.get(id);
    if (existing && Date.now() - existing.lastSeen < RATE_LIMIT_MS) {
      res.status(429).json({ error: 'rate limited' });
      return;
    }
    if (!existing && stations.size >= MAX_STATIONS) {
      res.status(503).json({ error: 'relay is full, try again later' });
      return;
    }

    stations.set(id, {
      lat: body.lat,
      lng: body.lng,
      accel: isFiniteNumberInRange(body.accel, 0, 5000) ? body.accel : 0,
      intensityValue: isFiniteNumberInRange(body.intensityValue, -3, 10) ? body.intensityValue : -3,
      trigger: !!body.trigger,
      lastSeen: Date.now(),
    });

    res.status(200).json({ ok: true, count: stations.size });
    return;
  }

  if (req.method === 'DELETE') {
    const id = String(req.query?.id || '').slice(0, 128);
    stations.delete(id);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
};
