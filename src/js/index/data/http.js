const TREM = require('../constant');
const fetchData = require('../../core/utils/fetch');
const Config = require('../../core/config');

let activeRequests = [];
let sseController = null;

function abortAll() {
  activeRequests.forEach((fetcher) => fetcher.controller.abort());
  activeRequests = [];

  // 中斷 SSE 串流
  if (sseController) {
    sseController.abort();
    sseController = null;
  }
}

/**
 * SSE 字串解析器
 * 輸入 raw text 回傳 parsed event array
 */
// function parseSSEEvents(raw) {
//   const events = [];
//   const blocks = raw.split(/(?=\n\n|event:|id:|data:)/).filter(Boolean);

//   for (const block of blocks) {
//     const trimmed = block.trim();
//     if (!trimmed) {
//       continue;
//     }

//     const dataMatch = trimmed.match(/^data:\s*(.+)$/m);
//     if (!dataMatch) {
//       continue;
//     }

//     try {
//       const parsed = JSON.parse(dataMatch[1]);
//       parsed._raw = trimmed;
//       events.push(parsed);
//     }
//     catch {
//       // raw JSON 不是有效物件，跳過
//     }
//   }

//   return events;
// }

/**
 * SSE 串流解析器
 * 持續讀取 ReadableStream，每次 yield 解析完的 event
 */
function* parseStream() {
  let buffer = '';

  while (true) {
    const yielded = yield;
    // yielded 可能是 { value: Uint8Array, done: false } 或是 Uint8Array 本身
    const result = yielded && typeof yielded === 'object' && 'value' in yielded
      ? yielded
      : { value: yielded, done: false };
    const { value, done } = result;

    if (done) {
      yield result;
      return;
    }

    buffer += new TextDecoder().decode(value, { stream: true });
    const blocks = buffer.split(/\n\n/);
    buffer = blocks.pop() ?? '';

    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) {
        continue;
      }

      const dataMatch = trimmed.match(/^data:\s*(.+)$/m);
      if (dataMatch) {
        try {
          const parsed = JSON.parse(dataMatch[1]);
          if (parsed != null) {
            yield { value: parsed, done: false };
          }
        }
        catch {
          // skip invalid JSON
        }
      }
    }

    yield result;
  }
}

let requestCounter = 0;

/**
 * SSE 即時串流訂閱
 * 啟動後持續將 rts/eew/intensity/lpgm 事件推入 listener
 * @param {Object} options
 * @param {Function} options.onRts - RTS 事件回調
 * @param {Function} options.onEew - EEW 事件回調
 * @param {Function} options.onIntensity - Intensity 事件回調
 * @param {Function} options.onLpgm - LP GM 事件回調
 * @param {number} options.reconnectDelay - 斷線重連延遲(ms)
 */
function init(options = {}) {
  const { onRts, onEew, onIntensity, onLpgm, reconnectDelay = 3000 } = options;

  // const wasAborted = sseController?.signal.aborted;
  // console.log(`[SSE][init] called, wasAborted=${wasAborted}, existing=${!!sseController}`);

  // 如果 controller 已存在且未中止，先中止重連避免重複
  if (sseController) {
    sseController.abort();
  }

  // 如果 signal 已中止，等待下一次 tick 再創建新的 controller
  if (sseController && sseController.signal.aborted) {
    // console.log('[SSE][init] signal is aborted, retrying in next tick');
    return new Promise((resolve) => {
      setTimeout(() => {
        const result = init(options);
        resolve(result);
      }, 16);
    });
  }

  sseController = new AbortController();
  const { signal } = sseController;
  // console.log('[SSE][init] new controller created, signal:', signal);

  function doConnect() {
    if (signal.aborted) {
      return;
    }

    const apiProxyDomain = Config.getInstance().getConfig().apiProxyDomain || 'api.lb.exptech.dev';
    const eewDomain = TREM.variable.play_mode == 2
      ? 'api.core.exptech.dev'
      : apiProxyDomain;
    const rtsDomain = TREM.variable.play_mode == 2
      ? 'api-1.exptech.dev'
      : apiProxyDomain;

    const urls = [
      { url: `https://${rtsDomain}/api/v2/trem/rts`, type: 'rts', enabled: TREM.variable.play_mode != 1 },
      { url: `https://${eewDomain}/api/v2/eq/eew`, type: 'eew', enabled: TREM.variable.play_mode != 1 },
    ];

    // if (requestCounter % 5 === 0) {
    //   urls.push({ url: `https://${TREM.constant.URL.API[0]}/api/v2/trem/intensity`, type: 'intensity' });
    // }
    // if (requestCounter % 7 === 0) {
    //   urls.push({ url: `https://${TREM.constant.URL.API[0]}/api/v2/trem/lpgm`, type: 'lpgm' });
    // }

    const requests = urls
      .filter((u) => u.enabled !== false)
      .map((u) =>
        fetch(u.url, {
          signal,
          headers: { 'Accept': 'text/event-stream', 'Cache-Control': 'no-cache' },
        })
          .then((res) => {
            if (!res.ok) {
              throw new Error(`HTTP ${res.status}`);
            }
            if (res.body) {
              return {
                ...u,
                reader: res.body.getReader(),
                stream: res.body,
              };
            }
            return null;
          })
          .catch((err) => {
            console.log(`[SSE] ${u.type} connect failed: ${err.message}`);
            return null;
          }),
      );

    Promise.all(requests).then((streams) => {
      const validStreams = streams.filter(Boolean);
      let reconnectionInProgress = false;

      function doReconnect() {
        if (reconnectionInProgress || signal.aborted) {
          return;
        }
        reconnectionInProgress = true;
        doConnect();
        setTimeout(() => {
          reconnectionInProgress = false;
        }, reconnectDelay);
      }

      validStreams.forEach(({ type, reader }) => {
        const parser = parseStream(reader, type);
        parser.next(); // prime the generator

        function readLoop() {
          if (signal.aborted) {
            return;
          }

          reader.read().then((result) => {
            if (signal.aborted) {
              return;
            }
            if (!result || typeof result !== 'object') {
              // reader.read() 回傳非 object（stream 結束或讀取失敗）
              // console.log(`[SSE][${type}] reader.read() unexpected result:`, result);
              doReconnect();
              return;
            }

            const { value, done } = result;
            if (done) {
              // console.log(`[SSE][${type}] stream done`);
              doReconnect();
              return;
            }

            // 修復：parser.next(value) 回傳 second yield 的結果 { value: parsed, done: false }
            const event = parser.next(value).value;
            if (event != null && (event.value != null || typeof event === 'object')) {
              switch (type) {
                case 'rts':
                  onRts?.(event);
                  break;
                case 'eew':
                  onEew?.(event);
                  break;
                case 'intensity':
                  onIntensity?.(event);
                  break;
                case 'lpgm':
                  onLpgm?.(event);
                  break;
              }
            }

            // 繼續讀下一筆
            readLoop();
          });
        }

        readLoop();
      });
    });
  }

  // 第一次啟動
  doConnect();

  // 回傳 abort 方法
  return {
    abort: () => sseController.abort(),
    // 更新 requestCounter 以控制 intensity/lpgm 是否拉取
    update: () => {
      requestCounter++;
      if (signal.aborted) {
        doConnect();
      }
    },
  };
}

async function getData(time) {
  time = Math.round(time / 1000);
  requestCounter++;
  const shouldFetchLPGM = requestCounter % 7 === 0;
  const shouldFetchIntensity = requestCounter % 5 === 0;

  // const url = (time)
  //   ? TREM.constant.URL.REPLAY[Math.floor(Math.random() * TREM.constant.URL.REPLAY.length)]
  //   : TREM.constant.URL.LB[Math.floor(Math.random() * TREM.constant.URL.LB.length)];

  const apiProxyDomain = Config.getInstance().getConfig().apiProxyDomain || 'api.lb.exptech.dev';

  const eewDomain = (TREM.variable.play_mode == 2)
    ? 'api.core.exptech.dev'
    : apiProxyDomain;
  const rtsDomain = (TREM.variable.play_mode == 2)
    ? 'api-1.exptech.dev'
    : apiProxyDomain;

  const rts_req = (TREM.variable.play_mode == 1)
    ? null
    : fetchData.withController(
        `https://${rtsDomain}/api/v2/trem/rts${(time) ? `/${time}` : ''}`,
        TREM.constant.HTTP_TIMEOUT.RTS,
      );
  const eew_req = (TREM.variable.play_mode == 1)
    ? null
    : fetchData.withController(
        `https://${eewDomain}/api/v2/eq/eew${(time) ? `/${time}` : ''}`,
        TREM.constant.HTTP_TIMEOUT.EEW,
      );

  const activeReqs = [rts_req, eew_req];
  let intensity_req, lpgm_req;

  if (shouldFetchIntensity) {
    intensity_req = fetchData.withController(
      `https://${TREM.constant.URL.API[0]}/api/v2/trem/intensity${(time) ? `/${time}` : ''}`,
      TREM.constant.HTTP_TIMEOUT.INTENSITY,
    );
    activeReqs.push(intensity_req);
  }

  if (shouldFetchLPGM) {
    lpgm_req = fetchData.withController(
      `https://${TREM.constant.URL.API[0]}/api/v2/trem/lpgm${(time) ? `/${time}` : ''}`,
      TREM.constant.HTTP_TIMEOUT.LPGM,
    );
    activeReqs.push(lpgm_req);
  }

  activeRequests.push(...activeReqs);

  try {
    const responses = await Promise.all(
      activeReqs.map((req) => {
        if (!req) {
          return null;
        }
        return req.execute().catch(() => null);
      }),
    );

    let rts = null, eew = null, intensity = null, lpgm = null;

    if (responses[0]?.ok) {
      rts = await responses[0].json();
    }
    if (responses[1]?.ok) {
      eew = await responses[1].json();
    }
    if (shouldFetchIntensity && responses[2]?.ok) {
      intensity = await responses[2].json();
    }
    if (shouldFetchLPGM && responses[responses.length - 1]?.ok) {
      lpgm = await responses[responses.length - 1].json();
    }

    return { rts, eew, intensity, lpgm };
  }
  finally {
    activeRequests = activeRequests.filter((req) => !activeReqs.includes(req));
  }
}

module.exports = getData;
module.exports.abortAll = abortAll;
module.exports.init = init;
