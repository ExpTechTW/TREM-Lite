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

async function initializeStyles() {
  const loadingIndicator = showLoadingIndicator();
  try {
    await loadCSS('../css/lang/zh-Hant/setting/plugin_edit/box.css');
    await new Promise((resolve) => setTimeout(resolve, 100));
    hideLoadingIndicator(loadingIndicator);
  }
  catch (error) {
    console.error('CSS 載入失敗:', error);
    hideLoadingIndicator(loadingIndicator);
  }
}

initializeStyles();
