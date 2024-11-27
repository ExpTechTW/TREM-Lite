class DropDown {
  constructor() {
    this.store = require('./store');
    this.storeData = new this.store();
    this.config = require('./config');
    this.Instance = this.config.Instance;
    this.intensityText = ['0級', '1級', '2級', '3級', '4級', '5弱', '5強', '6弱', '6強', '7級'];

    this.userLocation = document.querySelector('.usr-location');
    this.userLocationSelect = this.userLocation.querySelector('.select-wrapper');
    this.userCity = this.userLocation.querySelector('.city');
    this.userTown = this.userLocation.querySelector('.town');

    this.realtimeStation = document.querySelector('.realtime-station');
    this.realtimeStationSelect = this.realtimeStation.querySelector('.select-wrapper');
    this.realtimeCity = this.realtimeStation.querySelector('.city');
    this.realtimeTown = this.realtimeStation.querySelector('.town');
    this.realtimeStationSelect = this.realtimeStation.querySelector('.select-wrapper');

    this.mapDisplayEffect = document.querySelector('.map-display-effect');
    this.mapDisplayEffectSelect = this.mapDisplayEffect.querySelector('.select-wrapper');

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
    const selected = type == 1 ? this.warningRtsIntensity : this.warningEstIntensity;
    selected.querySelectorAll('.select-option-selected').forEach((div) => div.classList.remove('select-option-selected'));
    target.classList.add('select-option-selected');
    this.renderCurrent(target, type, 'intensity');
  }

  renderCity(targetElement) {
    this.storeData.processStation(TREM.variable.station);
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
    const isLocationMode = mode == 'location';
    const container = type == 1 ? (isLocationMode ? this.userLocation : this.warningRtsStation) : (isLocationMode ? this.realtimeStation : this.warningEstStation);
    const selectedElement = (type == 1 ? (isLocationMode ? this.userCity : this.warningRtsIntensity) : (isLocationMode ? this.realtimeCity : this.warningEstIntensity)).querySelector('.select-option-selected');
    const key = `${isLocationMode ? (type == 1 ? 'location' : 'station') : (type == 1 ? 'realtime-int' : 'estimate-int')}`;
    const currentElement = container.querySelector(`.setting-option > .location > .current${isLocationMode ? '' : ' > .warning-intensity'}`);
    const data = isLocationMode ? target.dataset?.name ? `${target.dataset.loc}-${target.dataset.name}` : `${selectedElement?.innerText || ''}-${target.textContent.trim()}` : selectedElement.dataset.id;
    if (isLocationMode) {
      currentElement.textContent = data;
    }
    else {
      currentElement.className = currentElement.className.split(' ').filter((cls) => !cls.startsWith('intensity-')).join(' ');
      currentElement.classList.add(`intensity-${data}`);
    }
    new this.config.Config().write({ DROPDOWN: { [key]: data } });
  }

  renderInstensity(targetElement) {
    const uniqueIntensity = [...new Set(this.intensityText)];
    targetElement.innerHTML = uniqueIntensity.map((int, index) => `<div data-id="${index}">${int}</div>`).join('');
  }

  async renderConfig(type, mode) {
    const isLocationMode = mode == 'location';
    await this.Instance.init();
    const current = type == 1 ? (isLocationMode ? this.Instance.data.DROPDOWN['location'] : this.Instance.data.DROPDOWN['realtime-int']) : (isLocationMode ? this.Instance.data.DROPDOWN['station'] : this.Instance.data.DROPDOWN['estimate-int']);
    const container = type == 1
      ? (isLocationMode ? this.userLocation : this.warningRtsStation)
      : (isLocationMode ? this.realtimeStation : this.warningEstStation);
    console.log(container, type, isLocationMode);

    const currentElement = container.querySelector(
      `.setting-option > .location > .current${isLocationMode ? '' : ' > .warning-intensity'}`,
    );

    if (isLocationMode) {
      currentElement.textContent = current;
    }
    else {
      currentElement.className = currentElement.className.split(' ').filter((cls) => !cls.startsWith('intensity-')).join(' ');
      currentElement.classList.add(`intensity-${current}`);
    }
  }
}
new DropDown();
