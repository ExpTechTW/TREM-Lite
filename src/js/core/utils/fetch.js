const logger = require('./logger');

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

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-cache',
    });

    clearTimeout(timeoutId);
    networkState.setOffline(false);

    return response;
  }
  catch (error) {
    clearTimeout(timeoutId);

    if (error.name === 'AbortError') {
      logger.error(`[utils/fetch.js] -> time out | ${url}`);
      throw new FetchError('Request timeout', 'TIMEOUT', url);
    }

    logger.error(`[utils/fetch.js] -> fetch error: ${url} | ${error.message}`);
    networkState.setOffline(true);
    throw new FetchError(error.message, 'NETWORK_ERROR', url);
  }
}

fetchData.withController = function (url, timeout = 1000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  return {
    execute: async () => {
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          cache: 'no-cache',
        });

        clearTimeout(timeoutId);
        networkState.setOffline(false);

        return response;
      }
      catch (error) {
        clearTimeout(timeoutId);

        if (error.name === 'AbortError') {
          logger.error(`[utils/fetch.js] -> time out | ${url}`);
          throw new FetchError('Request timeout', 'TIMEOUT', url);
        }

        logger.error(`[utils/fetch.js] -> fetch error: ${url} | ${error.message}`);
        networkState.setOffline(true);
        throw new FetchError(error.message, 'NETWORK_ERROR', url);
      }
    },
    controller,
  };
};

module.exports = fetchData;
