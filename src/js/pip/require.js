const { screen } = require('@electron/remote');

const logger = require('../js/core/utils/logger');

logger.info('Pip start');

require('../js/pip/nav');
require('../js/pip/lang');

const { ipcRenderer } = require('electron');

const pip_info_wrapper = document.getElementById('pip-info-wrapper');
const pip_info_unit = document.getElementById('pip-info-unit');
const pip_info_number = document.getElementById('pip-info-number');
const pip_info_loc = document.getElementById('pip-info-loc');
const pip_info_mag = document.getElementById('pip-info-mag');
const pip_info_depth = document.getElementById('pip-info-depth');
const pip_info_intensity = document.getElementById('pip-info-intensity');
const pip_info_footer = document.getElementById('pip-info-footer');
const pip_info_time = document.getElementById('pip-info-time');

ipcRenderer.on('update-pip-content', (event, data) => {
  if (data.noEew) {
    pip_info_wrapper.className = 'info-wrapper no-eew';
    pip_info_number.textContent = '';
    pip_info_number.className = 'info-number';
    pip_info_unit.textContent = '';
    return;
  }

  pip_info_wrapper.className = `info-wrapper ${data.statusClass}`;
  pip_info_number.textContent = data.serial;
  pip_info_number.className = `info-number${data.final ? ' info-number-last' : ''}`;
  pip_info_unit.textContent = data.unitText;
  pip_info_loc.textContent = data.loc;
  pip_info_depth.textContent = data.depth;
  pip_info_mag.textContent = data.mag;
  pip_info_intensity.className = `info-title-box intensity-${data.max}`;
  pip_info_footer.className = `info-footer${data.footer ? ' nsspe' : ''}`;
  pip_info_time.textContent = data.time;
});

function checkCursorPosition() {
  const position = screen.getCursorScreenPoint();
  const wrapper = document.getElementById('pip-info-wrapper');
  const rect = wrapper.getBoundingClientRect();
  const win = require('@electron/remote').getCurrentWindow();
  const winPos = win.getPosition();

  const relativeX = position.x - winPos[0];
  const relativeY = position.y - winPos[1];

  return {
    isInside: (
      relativeX >= rect.left
      && relativeX <= rect.right
      && relativeY >= rect.top
      && relativeY <= rect.bottom
    ),
  };
}

function startCursorCheck() {
  const buttonWrapper = document.querySelector('.window-button-wrapper');
  const buttonContain = document.querySelector('.window-button-contain');

  const checkInterval = setInterval(() => {
    const result = checkCursorPosition();
    buttonWrapper.style.display = result.isInside ? 'flex' : 'none';
    buttonContain.style.display = result.isInside ? 'block' : 'none';
  }, 100);

  window.addEventListener('unload', () => {
    clearInterval(checkInterval);
  });
}

startCursorCheck();
