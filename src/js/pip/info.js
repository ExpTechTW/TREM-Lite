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
const triggerBox = document.getElementById('trigger-box');

ipcRenderer.on('update-pip-content', (event, data) => {
  if (data.trigger) {
    const max = data.max;
    pip_info_wrapper.className = `info-wrapper no-eew ${max > 3 ? 'rts-trigger-high' : (max > 1) ? 'rts-trigger-middle' : 'rts-trigger-low'}`;

    triggerBox.innerHTML = '';

    for (let i = 0; i < 2; i++) {
      const triggerAreas = document.createElement('div');
      triggerAreas.className = 'trigger-areas';

      const startIndex = i * 4;
      const groupLocations = data.loc.slice(startIndex, startIndex + 4);

      console.log(groupLocations);

      groupLocations.forEach((location) => {
        const areaName = document.createElement('div');
        areaName.className = 'area-name';
        areaName.textContent = location.name;
        triggerAreas.appendChild(areaName);
      });

      triggerBox.appendChild(triggerAreas);
    }
    return;
  }

  if (data.noEew) {
    triggerBox.innerHTML = '';
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
