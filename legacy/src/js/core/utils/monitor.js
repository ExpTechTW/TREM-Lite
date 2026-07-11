// monitor.js
const logger = require('./logger');

function runMonitor(url, result, startTime) {
  const ttfb = Date.now() - startTime;

  // --- 情況 A：請求失敗 (網路錯誤、超時等) ---
  if (result instanceof Error) {
    const errorType = result.name === 'AbortError' ? 'TIMEOUT' : 'NET_ERR';
    logger.error(`[utils/monitor.js] 🚨 FAILED | ${ttfb.toString().padStart(4)}ms | ${errorType.padEnd(5)} | ${result.message} | ${url}`);
    return;
  }

  // --- 情況 B：請求成功 (有收到 HTTP 回應) ---
  try {
    const headers = result.headers;
    const status = result.status;
    const cacheStatus = headers.get('cf-cache-status') || 'MISS';
    const node = headers.get('x-served-by') || 'Unknown';

    const logMsg = `[utils/monitor.js] ${status} | ${ttfb.toString().padStart(4)}ms | ${cacheStatus.padEnd(5)} | ${node} | ${url}`;

    // 根據延遲程度決定 Log 等級
    if (ttfb > 1000 || status >= 400) {
      logger.warn(logMsg);
    }
    else {
      logger.info(logMsg);
    }

    // 地震預警 (EEW) 深度分析邏輯
    if (url.includes('/api/v2/eq/eew')) {
      const eewLog = headers.get('x-eew-log') || '';
      if (eewLog.includes('nats@')) {
        const natsTs = parseInt(eewLog.split('@')[1]);
        const dataLatency = Date.now() - natsTs;
        if (dataLatency > 2000) {
          logger.warn(`[utils/monitor.js] ⚠️  EEW 資料延遲過高: ${dataLatency}ms`);
        }
      }
    }
  }
  catch (err) {
    logger.error(`[utils/monitor.js] 分析過程出錯: ${err.message}`);
  }
}

module.exports = { runMonitor };
