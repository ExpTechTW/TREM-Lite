class DropDown {
  constructor() {
    this.store = require('./store');
    this.storeData = new this.store();
    this.initElements();
    this.initEvents();
    this.renderCity(this.userCity);
    this.renderCity(this.realtimeCity);
  }

  initElements() {
    this.userLocation = document.querySelector('.usr-location');
    this.userLocationSelect = this.userLocation.querySelector('.select-wrapper');
    this.userCity = this.userLocation.querySelector('.city');
    this.userTown = this.userLocation.querySelector('.town');
    this.realtimeStation = document.querySelector('.realtime-station');
    this.realtimeStationSelect = this.realtimeStation.querySelector('.select-wrapper');
    this.realtimeCity = this.realtimeStation.querySelector('.city');
    this.realtimeTown = this.realtimeStation.querySelector('.town');
  }

  initEvents() {
    this.addToggleClick(this.userLocation, this.userLocationSelect);
    this.addToggleClick(this.realtimeStation, this.realtimeStationSelect);
    this.userCity.addEventListener('click', (event) => this.handleCityEvent(event, 1));
    this.realtimeCity.addEventListener('click', (event) => this.handleCityEvent(event, 2));
    this.userTown.addEventListener('click', (event) => this.handleTownEvent(event, 1));
    this.realtimeTown.addEventListener('click', (event) => this.handleTownEvent(event, 2));
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
    const container = type === 1 ? this.userTown : this.realtimeTown;
    const selected = type === 1 ? this.userCity : this.realtimeCity;
    const data = type === 1
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
    const container = type === 1 ? this.userTown : this.realtimeTown;
    container.querySelectorAll('.select-option-selected').forEach((item) => item.classList.remove('select-option-selected'));
    target.classList.add('select-option-selected');
    this.renderCurrent(target, type);
  }

  renderCity(targetElement) {
    this.storeData.processStation(TREM.variable.station);
    const uniqueRegions = [...new Set(TREM.variable.city.map((city) => city.slice(0, -1)))].sort();
    targetElement.innerHTML = uniqueRegions.map((city) => `<div>${city}</div>`).join('');
  }

  renderTown(container, items, type) {
    const sortedItems = type === 1
      ? Object.entries(items).sort(([, a], [, b]) => a.code - b.code).map(([loc, data]) => ({ loc, ...data }))
      : items.sort((a, b) => a.code - b.code);
    container.innerHTML = sortedItems.map((item) =>
      type === 1
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

  renderCurrent(target, type) {
    const container = type === 1 ? this.userLocation : this.realtimeStation;
    const selectedCity = (type === 1 ? this.userCity : this.realtimeCity).querySelector('.select-option-selected');
    const currentElement = container.querySelector('.setting-option > .location > .current');
    currentElement.textContent = target.dataset?.name
      ? `${target.dataset.loc}-${target.dataset.name}`
      : `${selectedCity?.innerText || ''}-${target.textContent.trim()}`;
  }
}
new DropDown();
