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

document.querySelectorAll('.button').forEach((button) =>
  button.addEventListener('click', () => {
    document.querySelector('.setting-options-page.active')?.classList.remove('active');
    document.querySelector('.button.on')?.classList.remove('on');
    button.classList.add('on');
    document.querySelector(`.${button.getAttribute('for')}`)?.classList.add('active');
  }),
);

document.querySelector('.windows-wrapper').addEventListener('click', ({ target }) => {
  if (target.classList.contains('close')) {
    window.close();
  }
  else if (target.classList.contains('minimize')) {
    ipcRenderer.send('minimize-window');
  }
});
