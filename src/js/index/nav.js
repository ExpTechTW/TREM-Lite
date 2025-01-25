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
