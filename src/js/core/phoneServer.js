const https = require('https');
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const selfsigned = require('selfsigned');
const logger = require('./utils/logger');

const PORT = 8443;
const STALE_TIMEOUT = 15000;
const PAGE_PATH = path.join(__dirname, '../../resource/seismometer/seismometer.html');

let server = null;
let cleanupInterval = null;
let onUpdateCallback = null;
let nextStationNumber = 1;
const stations = new Map();

// ---- 配對權杖：/api/sensor 只認得帶正確權杖的請求 ----
// 一旦開放跨網路連線（穿透服務），這個伺服器的網址就不再只有同一個 Wi-Fi 的人連得到，
// 沒有這道驗證的話任何人都能冒充測站對 /api/sensor 送假資料（包含假觸發警報）。
// 權杖存在 userData，跟自簽憑證放一起；帶在網址的 query string 給手機端一次性讀取、
// 存進自己的 localStorage，之後每次回報都帶著送，不用使用者手動輸入配對碼。
let pairingToken = null;
let tokenPath = null;

function loadOrCreateToken(userDataDir) {
  const dir = path.join(userDataDir, 'phone-server');
  tokenPath = path.join(dir, 'token.json');
  fs.ensureDirSync(dir);

  if (fs.existsSync(tokenPath)) {
    try {
      const saved = fs.readJsonSync(tokenPath);
      if (saved && typeof saved.token === 'string' && saved.token) {
        pairingToken = saved.token;
        return pairingToken;
      }
    }
    catch { /* fall through and regenerate below */ }
  }

  pairingToken = crypto.randomBytes(16).toString('hex');
  fs.writeJsonSync(tokenPath, { token: pairingToken });
  return pairingToken;
}

function regenerateToken() {
  pairingToken = crypto.randomBytes(16).toString('hex');
  if (tokenPath) {
    fs.writeJsonSync(tokenPath, { token: pairingToken });
  }
  // 換了新權杖，舊權杖持有者（可能是已經不該再連的裝置）全部要重新配對，
  // 保留下來的殘留測站資料意義不大，直接清掉比較乾淨。
  stations.clear();
  broadcastUpdate();
  return pairingToken;
}

function isValidToken(candidate) {
  if (!pairingToken || typeof candidate !== 'string' || !candidate) {
    return false;
  }
  const a = Buffer.from(candidate);
  const b = Buffer.from(pairingToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- 跨網路穿透（cloudflared quick tunnel）：讓手機不用跟電腦在同一個 Wi-Fi 也能連線 ----
// cloudflared 的 Quick Tunnel 不用註冊帳號，網址是 Cloudflare 邊緣節點真正簽發的
// 憑證（*.trycloudflare.com），手機瀏覽器不會再跳「不安全」警告；--no-tls-verify
// 是讓 cloudflared 這一端接受本機那個自簽憑證（它才是真正對外服務的憑證來源，跟
// 對外顯示的 trycloudflare.com 憑證是兩回事）。跟基本的區網伺服器分開開關，
// 使用者要自己額外選擇「允許跨網路連線」才會啟動，避免預設就把裝置暴露到公網。
let tunnel = null;
let tunnelStatus = 'stopped'; // stopped | connecting | connected | error
let tunnelError = null;

const TUNNEL_URL_TIMEOUT_MS = 30000;

async function startTunnel() {
  if (tunnel) {
    return { status: tunnelStatus, url: tunnel.url ? withToken(tunnel.url) : null, error: tunnelError };
  }
  if (!server) {
    return { status: 'error', url: null, error: 'phone server is not running' };
  }

  tunnelStatus = 'connecting';
  tunnelError = null;

  try {
    // eslint-disable-next-line global-require
    const { Tunnel } = require('cloudflared');
    const client = Tunnel.quick(`https://127.0.0.1:${PORT}`, { '--no-tls-verify': true });

    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for tunnel url')), TUNNEL_URL_TIMEOUT_MS);
      client.once('url', (tunnelUrl) => {
        clearTimeout(timer);
        resolve(tunnelUrl);
      });
      client.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    client.url = url;
    tunnel = client;
    tunnelStatus = 'connected';

    client.on('error', (err) => {
      logger.error('[PhoneServer] tunnel error:', err);
      tunnelStatus = 'error';
      tunnelError = err.message;
    });
    client.on('exit', () => {
      tunnelStatus = 'stopped';
      tunnel = null;
    });

    return { status: tunnelStatus, url: withToken(tunnel.url), error: null };
  }
  catch (err) {
    logger.error('[PhoneServer] failed to start tunnel:', err);
    if (tunnel) {
      tunnel.stop();
    }
    tunnel = null;
    tunnelStatus = 'error';
    tunnelError = err.message;
    return { status: tunnelStatus, url: null, error: tunnelError };
  }
}

function stopTunnel() {
  if (tunnel) {
    tunnel.stop();
    tunnel = null;
  }
  tunnelStatus = 'stopped';
  tunnelError = null;
}

function withToken(url) {
  if (!url || !pairingToken) {
    return url;
  }
  return `${url}/${encodeURIComponent('地震儀.html')}?token=${pairingToken}`;
}

function getLocalIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

async function getCert(userDataDir, ips) {
  const certDir = path.join(userDataDir, 'phone-server');
  const certPath = path.join(certDir, 'cert.pem');
  const keyPath = path.join(certDir, 'key.pem');
  const metaPath = path.join(certDir, 'meta.json');

  if (fs.existsSync(certPath) && fs.existsSync(keyPath) && fs.existsSync(metaPath)) {
    try {
      const meta = fs.readJsonSync(metaPath);
      const coveredIps = new Set(meta.ips || []);
      if (ips.every((ip) => coveredIps.has(ip))) {
        return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
      }
    }
    catch { /* regenerate below */ }
  }

  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];

  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: 'trem-lite.local' }],
    {
      days: 3650,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'subjectAltName', altNames },
      ],
    },
  );

  fs.ensureDirSync(certDir);
  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(keyPath, pems.private);
  fs.writeJsonSync(metaPath, { ips });

  return { cert: pems.cert, key: pems.private };
}

function getStationList() {
  return Array.from(stations.entries()).map(([deviceId, data]) => ({ deviceId, ...data }));
}

function broadcastUpdate() {
  if (onUpdateCallback) {
    onUpdateCallback(getStationList());
  }
}

function cleanupStale() {
  const now = Date.now();
  let removed = false;
  for (const [deviceId, data] of stations) {
    if (now - data.lastSeen > STALE_TIMEOUT) {
      stations.delete(deviceId);
      removed = true;
    }
  }
  if (removed) {
    broadcastUpdate();
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function handleSensorPost(req, res) {
  if (!isValidToken(req.headers['x-pairing-token'])) {
    sendJson(res, 401, { error: 'invalid or missing pairing token' });
    return;
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1e6) {
      req.destroy();
    }
  });
  req.on('end', () => {
    let data;
    try {
      data = JSON.parse(body);
    }
    catch {
      sendJson(res, 400, { error: 'invalid json' });
      return;
    }

    const deviceId = String(data.deviceId || '').slice(0, 128);
    if (!deviceId) {
      sendJson(res, 400, { error: 'deviceId required' });
      return;
    }

    let station = stations.get(deviceId);
    if (!station) {
      station = { stationNumber: nextStationNumber++ };
      stations.set(deviceId, station);
    }

    Object.assign(station, {
      lat: typeof data.lat === 'number' ? data.lat : (station.lat ?? null),
      lng: typeof data.lng === 'number' ? data.lng : (station.lng ?? null),
      intensityValue: Number(data.intensityValue) || 0,
      intensityLabel: data.intensityLabel ?? '0',
      accel: Number(data.accel) || 0,
      maxAccel: Number(data.maxAccel) || 0,
      level: Number(data.level) || 0,
      trigger: data.trigger ? 1 : 0,
      lastSeen: Date.now(),
    });

    sendJson(res, 200, { stationNumber: station.stationNumber });
    broadcastUpdate();
  });
}

function handleSensorDelete(req, res, url) {
  if (!isValidToken(req.headers['x-pairing-token'])) {
    sendJson(res, 401, { error: 'invalid or missing pairing token' });
    return;
  }

  const deviceId = url.searchParams.get('deviceId');
  if (deviceId && stations.has(deviceId)) {
    stations.delete(deviceId);
    broadcastUpdate();
  }
  sendJson(res, 200, { ok: true });
}

function handleRequest(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  // url.pathname 保持 percent-encoded 原樣，不會自動解回中文，比對前要自己 decode。
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'GET' && (pathname === '/' || pathname === '/地震儀.html')) {
    fs.readFile(PAGE_PATH)
      .then((html) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      })
      .catch(() => {
        res.writeHead(500);
        res.end('seismometer page not found');
      });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/sensor') {
    handleSensorPost(req, res);
    return;
  }

  if (req.method === 'DELETE' && url.pathname === '/api/sensor') {
    handleSensorDelete(req, res, url);
    return;
  }

  res.writeHead(404);
  res.end('not found');
}

async function start(userDataDir, onUpdate) {
  if (server) {
    onUpdateCallback = onUpdate;
    return getStatus();
  }

  onUpdateCallback = onUpdate;
  loadOrCreateToken(userDataDir);
  const ips = getLocalIPs();
  const { cert, key } = await getCert(userDataDir, ips);

  return new Promise((resolve, reject) => {
    server = https.createServer({ cert, key }, handleRequest);

    server.once('error', (err) => {
      logger.error('[PhoneServer] failed to start:', err);
      server = null;
      reject(err);
    });

    server.listen(PORT, '0.0.0.0', () => {
      cleanupInterval = setInterval(cleanupStale, 5000);
      logger.info(`[PhoneServer] listening on port ${PORT}`);
      resolve(getStatus());
    });
  });
}

function stop() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  stopTunnel();
  stations.clear();
  onUpdateCallback = null;

  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    const closing = server;
    server = null;
    closing.close(() => resolve());
  });
}

function getStatus() {
  const ips = getLocalIPs();
  return {
    running: !!server,
    port: PORT,
    urls: ips.map((ip) => withToken(`https://${ip}:${PORT}`)),
    stations: getStationList(),
    tunnel: {
      status: tunnelStatus,
      url: withToken(tunnel?.url ?? null),
      error: tunnelError,
    },
  };
}

module.exports = {
  start, stop, getStatus, getStationList, startTunnel, stopTunnel, regenerateToken,
};
