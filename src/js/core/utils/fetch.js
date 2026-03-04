const { Pool } = require('undici');
const logger = require('./logger');
const { runMonitor } = require('./monitor');

class NetworkState {
  constructor() {
    this._isOffline = false;
  }

  setOffline(value) {
    if (this._isOffline !== value) {
      this._isOffline = value;
      if (!value) {
        logger.info(`[utils/fetch.js] -> Network restored`);
      }
    }
  }

  isOffline() {
    return this._isOffline;
  }
}

const networkState = new NetworkState();

class FetchError extends Error {
  constructor(message, type, url) {
    super(message);
    this.name = 'FetchError';
    this.type = type;
    this.url = url;
  }
}

async function fetchData(url, timeout = 1000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const pool = new Pool(new URL(url).origin, {
    pipelining: 0,
    connections: 1,
  });

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-cache',
      dispatcher: pool,
    });

    clearTimeout(timeoutId);
    networkState.setOffline(false);

    return response;
  }
  catch (error) {
    if (error.name === 'AbortError') {
      logger.error(`[utils/fetch.js] -> time out | ${url}`);
      throw new FetchError('Request timeout', 'TIMEOUT', url);
    }

    logger.error(`[utils/fetch.js] -> fetch error: ${url} | ${error.message}`);
    networkState.setOffline(true);
    throw new FetchError(error.message, 'NETWORK_ERROR', url);
  }
  finally {
    clearTimeout(timeoutId);
    pool.close();
  }
}

fetchData.withController = function (url, timeout = 1000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const pool = new Pool(new URL(url).origin, {
    pipelining: 0,
    connections: 1,
  });
  const startTime = Date.now(); // 記錄開始時間

  return {
    execute: async () => {
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          cache: 'no-cache',
          dispatcher: pool,
        });

        clearTimeout(timeoutId);
        networkState.setOffline(false);

        if (process.env.NODE_ENV === 'development') {
          runMonitor(url, response, startTime);
        }

        return response;
      }
      catch (error) {
        if (error.name === 'AbortError') {
          logger.error(`[utils/fetch.js] -> time out ${timeout} ms | ${url}`);
          throw new FetchError('Request timeout', 'TIMEOUT', url);
        }

        logger.error(`[utils/fetch.js] -> fetch error: ${url} | ${error.message}`);
        networkState.setOffline(true);
        throw new FetchError(error.message, 'NETWORK_ERROR', url);
      }
      finally {
        clearTimeout(timeoutId);
        pool.close();
      }
    },
    controller,
  };
};

module.exports = fetchData;
