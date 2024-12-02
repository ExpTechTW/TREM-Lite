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
  try {
    await loadCSS('../css/lang/zh-Hant/setting/plugin_edit/box.css');

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  catch (error) {
    console.error('CSS 載入失敗:', error);
  }
}

initializeStyles();
