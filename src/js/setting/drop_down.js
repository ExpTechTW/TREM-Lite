const Station_Wrapper = document.querySelector('.realtime-station');
const Station_Location = Station_Wrapper.querySelector('.location');
const Station_Select_Wrapper = Station_Wrapper.querySelector('.select-wrapper');
const Station_Local_Items = Station_Select_Wrapper.querySelector('.local');
const Station_Select = Station_Select_Wrapper.querySelector('.current-station');
const Station_Items = Station_Select_Wrapper.querySelector('.station');

const LocationWrapper = document.querySelector('.usr-location');
const Location = LocationWrapper.querySelector('.location');
const LocationSelWrapper = LocationWrapper.querySelector('.select-wrapper');

const Store = require('./store');
const StoreData = new Store();

function RenderCity() {
  Station_Local_Items.innerHTML = '';
  StoreData.processStationData(TREM.variable.station);

  const uniqueRegions = Array.from(
    new Set(TREM.variable.city.map((city) => city.slice(0, -1))),
  ).sort();

  uniqueRegions.forEach((city) => {
    Station_Local_Items.appendChild(StoreData.CreatEle(city));
  });
}
RenderCity();

Location.onclick = function () {
  const selectedBtn = this.querySelector('.selected-btn');
  selectedBtn.classList.toggle('on');
  LocationSelWrapper.classList.toggle('select-show-big');
};

const addLocationSelectEvent = (
  localItemsContainer,
  cityItemsContainer,
  selectElement,
) => {
  [localItemsContainer, cityItemsContainer].forEach((container) => {
    container.addEventListener('click', (event) => {
      const selectedDiv = event.target.closest(
        '.usr-location .select-items > div',
      );
      if (selectedDiv) {
        selectElement.textContent = selectedDiv.textContent;
        container
          .querySelectorAll('div')
          .forEach((div) => div.classList.remove('select-option-selected'));
        selectedDiv.classList.add('select-option-selected');
      }
    });
  });
};

function renderFilteredStations(stations) {
  stations.sort((a, b) => a.loc.localeCompare(b.loc));

  Station_Items.innerHTML = '';

  stations.forEach((station) => {
    const stationAttr = {
      'data-net': station.net,
      'data-code': station.code,
      'data-name': station.name,
      'data-loc': station.loc,
      'data-lat': station.lat,
      'data-lon': station.lon,
    };
    const stationDiv = StoreData.CreatEle('', '', '', '', stationAttr);

    const netSpan = document.createElement('span');
    netSpan.textContent = station.net;
    netSpan.classList = station.net;

    const infoSpan = document.createElement('span');
    infoSpan.textContent = `${station.code}-${station.name} ${station.loc}`;

    stationDiv.appendChild(netSpan);
    stationDiv.appendChild(infoSpan);
    Station_Items.appendChild(stationDiv);
  });
}

function handleCityItemClick(event) {
  const target = event.target.closest('#realtime-station .select-items > div');
  if (target) {
    Station_Local_Items.querySelectorAll('div').forEach((div) =>
      div.classList.remove('select-option-selected'),
    );
    target.classList.add('select-option-selected');

    const selectedCity = target.textContent;
    const filteredStations = variable.setting.station.filter((station) =>
      station.loc.includes(selectedCity),
    );
    renderFilteredStations(filteredStations);
  }
}
Station_Local_Items.onclick = handleCityItemClick;
