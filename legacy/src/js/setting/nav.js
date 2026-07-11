const { ipcRenderer } = require('electron');

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
