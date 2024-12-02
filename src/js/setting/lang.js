// 只有顏色而已，可用 ../index/constant
const TREM = require('../index/constant');

function generateColorCSS() {
  const styleContent = `
  <style id="dynamic-colors">
    :root {
      ${Object.entries(TREM.constant.COLOR.RTS)
        .map(([key, value]) => `--rts-${key.replace('_', '-')}: ${value};`)
        .join('\n')}
      
      ${Object.entries(TREM.constant.COLOR.INTENSITY)
        .map(([key, value]) => `--intensity-${key}: ${value};`)
        .join('\n')}
      
      ${Object.entries(TREM.constant.COLOR.INTENSITY_TEXT)
        .map(([key, value]) => `--intensity-text-${key}: ${value};`)
        .join('\n')}

      --rts-trigger-low: ${TREM.constant.COLOR.EEW.TRIGGER.LOW};
      --rts-trigger-middle: ${TREM.constant.COLOR.EEW.TRIGGER.MIDDLE};
      --rts-trigger-high: ${TREM.constant.COLOR.EEW.TRIGGER.HIGH};
      
      --eew-s-warn: ${TREM.constant.COLOR.EEW.S.WARN};
      --eew-s-alert: ${TREM.constant.COLOR.EEW.S.ALERT};
      --eew-s-cancel: ${TREM.constant.COLOR.EEW.S.CANCEL};
      --eew-p: ${TREM.constant.COLOR.EEW.P};
    }
  </style>
`;
  return styleContent;
}

function injectColorStyles() {
  document.head.insertAdjacentHTML('beforeend', generateColorCSS());
}

function loadCSS(href) {
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.href = href;

    link.onload = resolve;
    link.onerror = reject;

    document.head.appendChild(link);
  });
}

function showLoadingIndicator() {
  const loadingDiv = document.createElement('div');
  loadingDiv.id = 'css-loading-indicator';

  const animationContainer = document.createElement('div');
  animationContainer.className = 'loading-animation';

  const dotsContainer = document.createElement('div');
  dotsContainer.className = 'loading-dots';
  for (let i = 0; i < 4; i++) {
    dotsContainer.appendChild(document.createElement('div'));
  }

  animationContainer.appendChild(dotsContainer);
  loadingDiv.appendChild(animationContainer);

  document.body.appendChild(loadingDiv);
  return loadingDiv;
}

function hideLoadingIndicator(loadingDiv) {
  loadingDiv.style.opacity = '0';

  setTimeout(() => {
    document.body.removeChild(loadingDiv);
    document.body.classList.add('content-loaded');
    document.body.classList.add('fade-in');
  }, 500);
}

async function initializeStyles() {
  const loadingIndicator = showLoadingIndicator();

  try {
    injectColorStyles();
    await loadCSS('../css/lang/zh-Hant/setting/index.css');

    await new Promise((resolve) => setTimeout(resolve, 100));

    hideLoadingIndicator(loadingIndicator);
  }
  catch (error) {
    console.error('CSS 載入失敗:', error);
    hideLoadingIndicator(loadingIndicator);
  }
}

initializeStyles();
