const { screen } = require('@electron/remote');

const win = require('@electron/remote').getCurrentWindow();

const wrapper = document.getElementById('pip-info-wrapper');
const buttonWrapper = document.querySelector('.window-button-wrapper');
const buttonContain = document.querySelector('.window-button-contain');

function checkCursorPosition() {
  const position = screen.getCursorScreenPoint();
  const rect = wrapper.getBoundingClientRect();
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

(() => {
  const checkInterval = setInterval(() => {
    const result = checkCursorPosition();
    buttonWrapper.style.display = result.isInside ? 'flex' : 'none';
    buttonContain.style.display = result.isInside ? 'block' : 'none';
  }, 250);

  window.addEventListener('unload', () => clearInterval(checkInterval));
})();
