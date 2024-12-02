const TREM = require('./constant');
const intensityText = require('../index/utils/utils').intensity_list;

const Config = require('../core/config');

class DropDown {
  constructor() {
    this.config = Config.getInstance().getConfig(true);
    this.station = localStorage.getItem('cache.station') ?? {};

    this.userLocation = document.querySelector('.usr-location');
    this.userLocationSelect = this.userLocation.querySelector('.select-wrapper');
    this.userCity = this.userLocation.querySelector('.city');
    this.userTown = this.userLocation.querySelector('.town');

    this.realtimeStation = document.querySelector('.realtime-station');
    this.realtimeStationSelect = this.realtimeStation.querySelector('.select-wrapper');
    this.realtimeCity = this.realtimeStation.querySelector('.city');
    this.realtimeTown = this.realtimeStation.querySelector('.town');
    this.realtimeStationSelect = this.realtimeStation.querySelector('.select-wrapper');

    this.warningRtsStation = document.querySelector('.warning-realtime-station');
    this.warningRtsStationSelect = this.warningRtsStation.querySelector('.select-wrapper');
    this.warningRtsIntensity = this.warningRtsStationSelect.querySelector('.intensity');

    this.warningEstStation = document.querySelector('.warning-estimate-intensity');
    this.warningEstStationSelect = this.warningEstStation.querySelector('.select-wrapper');
    this.warningEstIntensity = this.warningEstStationSelect.querySelector('.intensity');

    this.init();
    this.renderConfig(1, 'location');
    this.renderConfig(2, 'location');
    this.renderConfig(3, 'intensity');
    this.renderConfig(4, 'intensity');
    this.renderCity(this.userCity);
    this.renderCity(this.realtimeCity);
    this.renderInstensity(this.warningRtsIntensity);
    this.renderInstensity(this.warningEstIntensity);

    this.CONTAINERS = [this.userLocation, this.realtimeStation, this.warningRtsStation, this.warningEstStation];
    this.SELECTED_ELEMENTS = [this.userCity, this.realtimeCity, this.warningRtsIntensity, this.warningEstIntensity];
  }

  init() {
    this.addToggleClick(this.userLocation, this.userLocationSelect);
    this.addToggleClick(this.realtimeStation, this.realtimeStationSelect);
    this.addToggleClick(this.warningRtsStation, this.warningRtsStationSelect);
    this.addToggleClick(this.warningEstStation, this.warningEstStationSelect);
    this.userCity.addEventListener('click', (event) => this.handleCityEvent(event, 1));
    this.realtimeCity.addEventListener('click', (event) => this.handleCityEvent(event, 2));
    this.userTown.addEventListener('click', (event) => this.handleTownEvent(event, 1));
    this.realtimeTown.addEventListener('click', (event) => this.handleTownEvent(event, 2));
    this.warningRtsIntensity.addEventListener('click', (event) => this.handleIntensityEvent(event, 3));
    this.warningEstIntensity.addEventListener('click', (event) => this.handleIntensityEvent(event, 4));
  }

  addToggleClick(container, toggleClass) {
    container.addEventListener('click', (event) => {
      const select = event.target.querySelector('.selected-btn');
      if (select) {
        select.classList.toggle('on');
        toggleClass.classList.toggle('select-show-big');
      }
    });
  }

  handleCityEvent(event, type) {
    const target = event.target.closest('.select-items > div');
    if (!target) {
      return;
    }
    const container = type == 1 ? this.userTown : this.realtimeTown;
    const selected = type == 1 ? this.userCity : this.realtimeCity;
    const data = type == 1
      ? TREM.variable.region[Object.keys(TREM.variable.region).find((region) => region.includes(target.textContent))]
      : TREM.variable.station.filter((station) => station.loc.includes(target.textContent));
    selected.querySelectorAll('.select-option-selected').forEach((div) => div.classList.remove('select-option-selected'));
    target.classList.add('select-option-selected');
    this.renderTown(container, data, type);
  }

  handleTownEvent(event, type) {
    const target = event.target.closest('.select-items > div');
    if (!target) {
      return;
    }
    const container = type == 1 ? this.userTown : this.realtimeTown;
    container.querySelectorAll('.select-option-selected').forEach((item) => item.classList.remove('select-option-selected'));
    target.classList.add('select-option-selected');
    this.renderCurrent(target, type, 'location');
  }

  handleIntensityEvent(event, type) {
    const target = event.target.closest('.select-items > div');
    if (!target) {
      return;
    }
    const selected = (type == 3 ? this.warningRtsIntensity : (type == 4 ? this.warningEstIntensity : ''));
    selected.querySelectorAll('.select-option-selected').forEach((div) => div.classList.remove('select-option-selected'));
    target.classList.add('select-option-selected');
    this.renderCurrent(target, type, 'intensity');
  }

  processStation(data) {
    TREM.variable.city = TREM.variable.city || [];
    Object.entries(data).forEach(([station, { info = [], net = '未知' } = {}]) => {
      const latestInfo = info.at(-1);
      if (!latestInfo || latestInfo.code === 0) {
        return;
      }
      const loc = this.codeToString(TREM.variable.region, latestInfo.code);
      if (loc?.city && !TREM.variable.city.some((city) => city.city === loc.city)) {
        TREM.variable.city.push({ code: loc.code, city: loc.city });
      }
      this.station.push({
        name: station,
        net,
        loc: loc?.city ? `${loc.city}${loc.town}` : loc,
        code: latestInfo.code,
        lat: latestInfo.lat,
        lon: latestInfo.lon,
      });
    });
    return (TREM.variable.station = this.station);
  }

  codeToString(region, code) {
    for (const [city, towns] of Object.entries(region)) {
      for (const [town, details] of Object.entries(towns)) {
        if (details.code === code) {
          return { city, town, ...details };
        }
      }
    }
    return null;
  }

  formatTime(timestamp) {
    return new Date(timestamp).toISOString().replace('T', ' ').split('.')[0];
  }

  renderCity(targetElement) {
    this.processStation(this.station);
    const uniqueCities = [...new Set(TREM.variable.city.sort((a, b) => a.code - b.code).map((item) => item.city))];
    targetElement.innerHTML = uniqueCities.map((city) => `<div>${city}</div>`).join('');
  }

  renderTown(container, items, type) {
    const sortedItems = type == 1
      ? Object.entries(items).sort(([, a], [, b]) => a.code - b.code).map(([loc, data]) => ({ loc, ...data }))
      : items.sort((a, b) => a.code - b.code);
    container.innerHTML = sortedItems.map((item) =>
      type == 1
        ? `<div>${item.loc}</div>`
        : `<div 
            data-net="${item.net}" 
            data-code="${item.code}" 
            data-name="${item.name}" 
            data-loc="${item.loc}" 
            data-lat="${item.lat}" 
            data-lon="${item.lon}">
            <span class="${item.net}">${item.net}</span>
            <span>${item.code}-${item.name} ${item.loc}</span>
          </div>`,
    ).join('');
  }

  renderCurrent(target, type, mode) {
    const isLocationMode = mode === 'location';
    if (type > 4) {
      return;
    }
    const container = this.CONTAINERS[type - 1];
    const selectedElement = this.SELECTED_ELEMENTS[type - 1].querySelector('.select-option-selected');
    const key = this.KEYS[type - 1];
    const currentElement = container.querySelector(`.setting-option > .location > .current${isLocationMode ? '' : ' > .warning-intensity'}`);
    const data = isLocationMode
      ? target.dataset?.name
        ? `${target.dataset.loc}-${target.dataset.name}`
        : `${selectedElement?.innerText || ''}-${target.textContent.trim()}`
      : selectedElement.dataset.id;

    if (isLocationMode) {
      currentElement.textContent = data;
    }
    else {
      currentElement.className = currentElement.className
        .split(' ')
        .filter((cls) => !cls.startsWith('intensity-'))
        .join(' ');
      currentElement.classList.add(`intensity-${data}`);
    }
    new this.config.Config().write({ DROPDOWN: { [key]: data } });
  }

  renderInstensity(targetElement) {
    const uniqueIntensity = [...new Set(intensityText)];
    targetElement.innerHTML = uniqueIntensity.map((int, index) => `<div data-id="${index}">${int}</div>`).join('');
  }

  renderConfig(type, mode) {
    if (type > 4) {
      return;
    }
    const isLocationMode = mode === 'location';
    this.init();
    // const current = this.Instance.data.DROPDOWN[this.KEYS[type - 1]];
    // const container = this.CONTAINERS[type - 1];
    // const currentElement = container.querySelector(`.setting-option > .location > .current${isLocationMode ? '' : ' > .warning-intensity'}`);
    // if (isLocationMode) {
    //   currentElement.textContent = current;
    // }
    // else {
    //   currentElement.className = currentElement.className.split(' ').filter((cls) => !cls.startsWith('intensity-')).join(' ');
    //   currentElement.classList.add(`intensity-${current || 0}`);
    // }
  }
}
new DropDown();
