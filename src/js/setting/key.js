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
    document.querySelector(`.${button.getAttribute('for')}`).classList.add('active');
    button.classList.add('on');
  }),
);

document.querySelector('.windows-wrapper').addEventListener('click', (event) => {
  const targetClass = event.target.classList;
  if (targetClass.contains('close')) {
    window.close();
  }
  else if (targetClass.contains('minimize')) {
    ipcRenderer.send('minimize-window');
  }
});
