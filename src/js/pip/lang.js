const TREM = require('../index/constant');

function generateColorCSS() {
  let css = ':root {\n';

  Object.entries(TREM.constant.COLOR.RTS).forEach(([key, value]) => {
    const cssKey = key.replace('_', '-');
    css += `  --rts-${cssKey}: ${value};\n`;
  });

  Object.entries(TREM.constant.COLOR.INTENSITY).forEach(([key, value]) => {
    css += `  --intensity-${key}: ${value};\n`;
  });

  Object.entries(TREM.constant.COLOR.INTENSITY_TEXT).forEach(([key, value]) => {
    css += `  --intensity-text-${key}: ${value};\n`;
  });

  css += `  --eew-s-warn: ${TREM.constant.COLOR.EEW.S.WARN};\n`;
  css += `  --eew-s-alert: ${TREM.constant.COLOR.EEW.S.ALERT};\n`;
  css += `  --eew-s-cancel: ${TREM.constant.COLOR.EEW.S.CANCEL};\n`;
  css += `  --eew-p: ${TREM.constant.COLOR.EEW.P};\n`;

  css += '}\n';
  return css;
}

function injectColorStyles() {
  const style = document.createElement('style');
  style.textContent = generateColorCSS();
  document.head.appendChild(style);
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
    await loadCSS('../css/lang/zh-Hant/pip/index.css');

    await new Promise((resolve) => setTimeout(resolve, 100));

    hideLoadingIndicator(loadingIndicator);
  }
  catch (error) {
    console.error('CSS 載入失敗:', error);
    hideLoadingIndicator(loadingIndicator);
  }
}

initializeStyles();
