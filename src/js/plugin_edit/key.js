const { ipcRenderer } = require('electron');

document.onkeydown = (e) => {
  if (e.ctrlKey) {
    switch (e.code) {
      case 'KeyR':
        return ipcRenderer.send('reload');

      default:
        return;
    }
  }

  switch (e.code) {
    case 'F1':
      return ipcRenderer.send('openPluginFolder');

    case 'F2':
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

document.querySelector('.windows-wrapper').addEventListener('click', ({ target }) => {
  if (target.classList.contains('close')) {
    window.close();
  }
  else if (target.classList.contains('minimize')) {
    ipcRenderer.send('minimize-window');
  }
  else if (target.classList.contains('maximize')) {
    ipcRenderer.send('maximize-window');
  }
});
