const logger = require('./logger');

let isOffline = false;

async function fetchData(url, timeout = 1000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-cache' });
    clearTimeout(timeoutId);

    if (isOffline) {
      logger.info(`[utils/fetch.js] -> Network restored`);
      isOffline = false;
    }

    return response;
  }
  catch (error) {
    if (!isOffline) {
      if (error.name === 'AbortError') {
        logger.error(`[utils/fetch.js] -> time out | ${url}`);
      }
      else {
        logger.error(`[utils/fetch.js] -> fetch error: ${url} | ${error.message}`);
      }
      isOffline = true;
    }

    return null;
  }
}

fetchData.withController = function (url, timeout = 1000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  return {
    execute: async () => {
      try {
        const response = await fetch(url, { signal: controller.signal, cache: 'no-cache' });
        clearTimeout(timeoutId);

        if (isOffline) {
          logger.info(`[utils/fetch.js] -> Network restored`);
          isOffline = false;
        }

        return response;
      }
      catch (error) {
        if (!isOffline) {
          if (error.name === 'AbortError') {
            logger.error(`[utils/fetch.js] -> time out | ${url}`);
          }
          else {
            logger.error(`[utils/fetch.js] -> fetch error: ${url} | ${error.message}`);
          }
          isOffline = true;
        }

        return null;
      }
    },
    controller,
  };
};

module.exports = fetchData;
