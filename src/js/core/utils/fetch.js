const logger = require('./logger');

async function fetchData(url, timeout = 1000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-cache' });
    clearTimeout(timeoutId);
    return response;
  }
  catch (error) {
    if (error.name === 'AbortError') {
      logger.error(`[utils/fetch.js] -> time out | ${url}`);
    }
    else {
      logger.error(`[utils/fetch.js] -> fetch error: ${url} | ${error.message}`);
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
        return response;
      }
      catch (error) {
        if (error.name === 'AbortError') {
          logger.error(`[utils/fetch.js] -> time out | ${url}`);
        }
        else {
          logger.error(`[utils/fetch.js] -> fetch error: ${url} | ${error.message}`);
        }
        return null;
      }
    },
    controller,
  };
};

module.exports = fetchData;
