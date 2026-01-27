const { ipcRenderer } = require('electron');
const { app } = require('@electron/remote');

document.onkeydown = (e) => {
  if (e.ctrlKey) {
    switch (e.code) {
      case 'KeyR':
        return ipcRenderer.send('all-reload');

      default:
        return;
    }
  }

  switch (e.code) {
    case 'F1':
      return ipcRenderer.send('openPluginFolder');

    case 'F2':
      return ipcRenderer.send('openTempFolder');

    case 'F3':
      return ipcRenderer.send('openConfigFolder');

    case 'F4':
      return ipcRenderer.send('openReplayFolder');

    case 'F11':
      return ipcRenderer.send('toggleFullscreen');

    case 'F12':
      return ipcRenderer.send('openDevtool');

    case 'Escape':
      return ipcRenderer.send('hide');

    case 'Tab':
      return e.preventDefault();
  }
};

document.querySelector('.fab').addEventListener('click', function () {
  this.classList.toggle('open');
  document.querySelectorAll('.option').forEach((option) => {
    option.classList.toggle('open');
  });
  document.querySelectorAll('.close').forEach((close) => {
    close.classList.toggle('open');
  });
});

document.getElementById('setting').addEventListener('click', () => ipcRenderer.send('openSettingWindow'));

document.getElementById('current-version').textContent = app.getVersion();

ipcRenderer.on('update-available', (_event, info) => {
  const notification = new Notification('🔔 發現新版本', {
    body: `發現新版本 ${info.version}，正在自動下載中...\n下載完成後將在 3 秒後重啟安裝更新`,
    icon: '../TREM.ico',
  });

  notification.onclick = () => {
    ipcRenderer.send('openSettingWindow');
  };
});

ipcRenderer.on('update-downloaded', (_event, info) => {
  const notification = new Notification('✅ 更新已下載完成', {
    body: `版本 ${info.version} 已下載完成，應用程式將在 3 秒後重啟安裝更新...`,
    icon: '../TREM.ico',
  });

  notification.onclick = () => {
    ipcRenderer.send('openSettingWindow');
  };
});
