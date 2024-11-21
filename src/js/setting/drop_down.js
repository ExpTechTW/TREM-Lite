class DropDown {
  constructor() {
    this.store = require('./store');
    this.storeData = new this.store();

    this.userLocation = document.querySelector('.usr-location');
    this.userLocationSelect = this.userLocation.querySelector('.select-wrapper');
    this.userCity = this.userLocation.querySelector('.city');
    this.userTown = this.userLocation.querySelector('.town');

    this.realtimeStation = document.querySelector('.realtime-station');
    this.realtimeStationSelect = this.realtimeStation.querySelector('.select-wrapper');
    this.realtimeCity = this.realtimeStation.querySelector('.city');
    this.realtimeTown = this.realtimeStation.querySelector('.town');

    this.renderCity(this.userCity);
    this.renderCity(this.realtimeCity);
    this.clickEvents();
  }

  renderCity(targetElement) {
    this.storeData.processStation(TREM.variable.station);
    const uniqueRegions = Array.from(new Set(TREM.variable.city.map((city) => city.slice(0, -1)))).sort();
    const cityHTML = uniqueRegions
      .map((city) => `<div>${city}</div>`)
      .join('');
    targetElement.innerHTML = cityHTML;
  }

  clickEvents() {
    this.toggleClick(this.userLocation, this.userLocationSelect, 'select-show-big');
    this.toggleClick(this.realtimeStation, this.realtimeStationSelect, 'select-show-big');
    this.userCity.addEventListener('click', (event) => this.handleEvent(event, 1));
    this.realtimeCity.addEventListener('click', (event) => this.handleEvent(event, 2));
  }

  toggleClick(container, toggleClass, targetClass) {
    container.addEventListener('click', (event) => {
      const select = event.target.querySelector('.selected-btn');
      if (!select) {
        return;
      }
      select.classList.toggle('on');
      toggleClass.classList.toggle(targetClass);
    });
  }

  renderTown(container, items, type) {
    if (type == 1) {
      items = Object.entries(items)
        .sort(([, a], [, b]) => a.code - b.code)
        .map(([loc, data]) => ({ loc, ...data }));
      container.innerHTML = items.map((item) => `<div>${item.loc}</div>`).join('');
    }
    else {
      items.sort((a, b) => a.code - b.code);
      container.innerHTML = items
        .map(
          (station) => `
        <div 
          data-net="${station.net}" 
          data-code="${station.code}" 
          data-name="${station.name}" 
          data-loc="${station.loc}" 
          data-lat="${station.lat}" 
          data-lon="${station.lon}">
          <span class="${station.net}">${station.net}</span>
          <span>${station.code}-${station.name} ${station.loc}</span>
        </div>
      `,
        )
        .join('');
    }
  }

  handleEvent(event, type) {
    const target = event.target.closest('.select-items > div');
    if (!target) {
      return;
    }
    const container = type === 1 ? this.userTown : this.realtimeTown;
    const selected = type === 1 ? this.userCity : this.realtimeCity;
    const data = type === 1
      ? TREM.variable.region[Object.keys(TREM.variable.region).find((region) => region.includes(target.textContent))]
      : TREM.variable.station.filter((station) => station.loc.includes(target.textContent));
    selected.querySelectorAll('div').forEach((div) => div.classList.remove('select-option-selected'));
    target.classList.add('select-option-selected');
    this.renderTown(container, data, type);
  }
}
new DropDown();
