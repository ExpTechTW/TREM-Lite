const TREM = require('./constant');
const { intensity_list: intensityText } = require('../index/utils/utils');
const Config = require('../core/config');
const logger = require('../core/utils/logger');

class DropDown {
  constructor() {
    logger.info('DropDown: Initializing...');

    this.KEYS = ['location', 'station', 'realtime-int', 'estimate-int'];
    this.debug = true;

    try {
      this.configInstance = Config.getInstance();
      this.config = this.configInstance.getConfig(true);
      this.log('Config loaded:', this.config);

      const stationCache = localStorage.getItem('cache.station');
      this.station = stationCache ? JSON.parse(stationCache) : {};
      this.log('Station cache loaded:', this.station);

      TREM.variable = TREM.variable || {};
      TREM.variable.city = [];
      TREM.variable.station = [];

      this.initializeElements();
      this.init();
      this.initializeConfigs();
    }
    catch (error) {
      this.logError('Constructor error:', error);
    }
  }

  initializeElements() {
    try {
      this.userLocation = this.querySelector('.usr-location', 'User Location container');
      this.userLocationSelect = this.querySelector('.select-wrapper', 'User Location Select wrapper', this.userLocation);
      this.userCity = this.querySelector('.city', 'User City', this.userLocation);
      this.userTown = this.querySelector('.town', 'User Town', this.userLocation);

      this.realtimeStation = this.querySelector('.realtime-station', 'Realtime Station container');
      this.realtimeStationSelect = this.querySelector('.select-wrapper', 'Realtime Station Select wrapper', this.realtimeStation);
      this.realtimeCity = this.querySelector('.city', 'Realtime City', this.realtimeStation);
      this.realtimeTown = this.querySelector('.town', 'Realtime Town', this.realtimeStation);

      this.warningRtsStation = this.querySelector('.warning-realtime-station', 'Warning RTS Station container');
      this.warningRtsStationSelect = this.querySelector('.select-wrapper', 'Warning RTS Station Select wrapper', this.warningRtsStation);
      this.warningRtsIntensity = this.querySelector('.intensity', 'Warning RTS Intensity', this.warningRtsStationSelect);

      this.warningEstStation = this.querySelector('.warning-estimate-intensity', 'Warning EST Station container');
      this.warningEstStationSelect = this.querySelector('.select-wrapper', 'Warning EST Station Select wrapper', this.warningEstStation);
      this.warningEstIntensity = this.querySelector('.intensity', 'Warning EST Intensity', this.warningEstStationSelect);

      this.CONTAINERS = [this.userLocation, this.realtimeStation, this.warningRtsStation, this.warningEstStation];
      this.SELECTED_ELEMENTS = [this.userCity, this.realtimeCity, this.warningRtsIntensity, this.warningEstIntensity];

      this.log('All elements initialized successfully');
    }
    catch (error) {
      this.logError('Element initialization error:', error);
      throw error;
    }
  }

  querySelector(selector, elementName, parent = document) {
    const element = parent.querySelector(selector);
    if (!element) {
      throw new Error(`${elementName} (${selector}) not found`);
    }
    return element;
  }

  initializeConfigs() {
    try {
      this.log('Initializing configs...');
      this.renderConfig(1, 'location');
      this.renderConfig(2, 'location');
      this.renderConfig(3, 'intensity');
      this.renderConfig(4, 'intensity');
      this.renderCity(this.userCity);
      this.renderCity(this.realtimeCity);
      this.renderInstensity(this.warningRtsIntensity);
      this.renderInstensity(this.warningEstIntensity);
      this.log('Configs initialized successfully');
    }
    catch (error) {
      this.logError('Config initialization error:', error);
    }
  }

  init() {
    try {
      this.log('Adding event listeners...');
      this.addToggleClick(this.userLocation, this.userLocationSelect);
      this.addToggleClick(this.realtimeStation, this.realtimeStationSelect);
      this.addToggleClick(this.warningRtsStation, this.warningRtsStationSelect);
      this.addToggleClick(this.warningEstStation, this.warningEstStationSelect);

      this.addEventListeners();
      this.log('Event listeners added successfully');
    }
    catch (error) {
      this.logError('Initialization error:', error);
    }
  }

  addEventListeners() {
    const listeners = [
      { element: this.userCity, handler: (e) => this.handleCityEvent(e, 1), name: 'userCity' },
      { element: this.realtimeCity, handler: (e) => this.handleCityEvent(e, 2), name: 'realtimeCity' },
      { element: this.userTown, handler: (e) => this.handleTownEvent(e, 1), name: 'userTown' },
      { element: this.realtimeTown, handler: (e) => this.handleTownEvent(e, 2), name: 'realtimeTown' },
      { element: this.warningRtsIntensity, handler: (e) => this.handleIntensityEvent(e, 3), name: 'warningRtsIntensity' },
      { element: this.warningEstIntensity, handler: (e) => this.handleIntensityEvent(e, 4), name: 'warningEstIntensity' },
    ];

    listeners.forEach(({ element, handler, name }) => {
      if (element) {
        element.addEventListener('click', handler);
        this.log(`Added click listener to ${name}`);
      }
      else {
        this.logError(`Failed to add listener: ${name} element not found`);
      }
    });
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
    try {
      const target = event.target.closest('.select-items > div');
      if (!target) {
        return;
      }

      const container = type === 1 ? this.userTown : this.realtimeTown;
      const selected = type === 1 ? this.userCity : this.realtimeCity;

      let data;
      if (type === 1) {
        const regionKey = Object.keys(TREM.variable.region)
          .find((region) => region.includes(target.textContent));
        data = TREM.variable.region[regionKey];
      }
      else {
        data = TREM.variable.station.filter((station) =>
          station.loc.includes(target.textContent),
        );
      }

      selected.querySelectorAll('.select-option-selected')
        .forEach((div) => div.classList.remove('select-option-selected'));
      target.classList.add('select-option-selected');

      this.renderTown(container, data, type);
    }
    catch (error) {
      this.logError('Handle city event error:', error);
    }
  }

  handleTownEvent(event, type) {
    try {
      const target = event.target.closest('.select-items > div');
      if (!target) {
        return;
      }

      const container = type === 1 ? this.userTown : this.realtimeTown;
      container.querySelectorAll('.select-option-selected')
        .forEach((item) => item.classList.remove('select-option-selected'));
      target.classList.add('select-option-selected');

      if (type === 1) {
        const cityElement = this.userCity.querySelector('.select-option-selected');
        const cityName = cityElement?.textContent;
        const townName = target.textContent;
        const regionData = TREM.variable.region[cityName];
        const townData = regionData[townName];

        if (townData?.code) {
          const code = parseInt(townData.code);
          target.dataset.code = code.toString();

          this.configInstance.writeConfig({
            ...this.configInstance.getConfig(),
            'location-code': code,
          });

          const displayText = `${cityName}${townName}`;
          const currentElement = this.userLocation.querySelector(
            '.setting-option > .location > .current',
          );
          if (currentElement) {
            currentElement.textContent = displayText;
          }
          return;
        }
      }

      this.renderCurrent(target, type, 'location');
    }
    catch (error) {
      this.logError('Handle town event error:', error);
    }
  }

  handleIntensityEvent(event, type) {
    try {
      const target = event.target.closest('.select-items > div');
      if (!target) {
        return;
      }

      const selected = type === 3 ? this.warningRtsIntensity : this.warningEstIntensity;
      selected.querySelectorAll('.select-option-selected')
        .forEach((div) => div.classList.remove('select-option-selected'));
      target.classList.add('select-option-selected');

      const currentConfig = this.configInstance.getConfig();
      const intensityValue = target.dataset.id;

      if (type === 3) {
        this.configInstance.writeConfig({
          ...currentConfig,
          'alert-level': {
            ...currentConfig['alert-level'],
            'rts-intensity': intensityValue,
          },
        });
      }
      else if (type === 4) {
        this.configInstance.writeConfig({
          ...currentConfig,
          'alert-level': {
            ...currentConfig['alert-level'],
            'eew-intensity': intensityValue,
          },
        });
      }

      this.renderCurrent(target, type, 'intensity');
    }
    catch (error) {
      this.logError('Handle intensity event error:', error);
    }
  }

  processStation(stationData) {
    try {
      this.log('Processing station data...');
      TREM.variable.city = [];
      TREM.variable.station = [];

      Object.entries(stationData).forEach(([stationId, stationInfo]) => {
        const { info = [], net = 'unknown' } = stationInfo;
        const latestInfo = info[info.length - 1];

        if (!latestInfo || latestInfo.code === 0) {
          return;
        }

        const loc = this.codeToString(TREM.variable.region, latestInfo.code);
        if (loc?.city && !TREM.variable.city.some((city) => city.city === loc.city)) {
          TREM.variable.city.push({
            code: loc.code,
            city: loc.city,
          });
        }

        TREM.variable.station.push({
          name: stationId,
          net,
          loc: loc?.city ? `${loc.city}${loc.town}` : loc,
          code: latestInfo.code,
          lat: latestInfo.lat,
          lon: latestInfo.lon,
        });
      });

      return TREM.variable.station;
    }
    catch (error) {
      this.logError('Process station error:', error);
      return [];
    }
  }

  renderCity(targetElement) {
    try {
      this.processStation(this.station);

      this.log('Rendering city for element:', targetElement);

      if (!targetElement) {
        throw new Error('Target element is not found');
      }

      const uniqueCities = [...new Set(
        TREM.variable.city
          .sort((a, b) => a.code - b.code)
          .map((item) => item.city)
          .filter(Boolean),
      )];

      targetElement.innerHTML = uniqueCities.length > 0
        ? uniqueCities.map((city) => `<div>${city || 'unknown'}</div>`).join('')
        : '';
    }
    catch (error) {
      this.logError('renderCity error:', error);
      targetElement.innerHTML = '<div>Failed to load</div>';
    }
  }

  renderTown(container, items, type) {
    try {
      const sortedItems = type === 1
        ? Object.entries(items)
          .sort(([, a], [, b]) => a.code - b.code)
          .map(([loc, data]) => ({ loc, ...data }))
        : items.sort((a, b) => a.code - b.code);

      container.innerHTML = sortedItems.map((item) =>
        type === 1
          ? `<div data-code="${item.code}">${item.loc}</div>`
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

      if (type === 2) {
        const stationId = this.config['realtime-station-id'];
        if (stationId) {
          const target = container.querySelector(`[data-name="${stationId}"]`);
          if (target) {
            target.classList.add('select-option-selected');
          }
        }
      }
    }
    catch (error) {
      this.logError('renderTown error:', error);
      container.innerHTML = '<div>Failed to load</div>';
    }
  }

  renderInstensity(targetElement) {
    try {
      if (!targetElement) {
        throw new Error('Target element for intensity is not found');
      }
      if (!Array.isArray(intensityText)) {
        throw new Error('Intensity text is not properly defined');
      }

      const uniqueIntensity = [...new Set(intensityText)];
      targetElement.innerHTML = uniqueIntensity.map((int, index) =>
        `<div data-id="${index}">${int || 'unknown'}</div>`,
      ).join('');
    }
    catch (error) {
      this.logError('renderIntensity error:', error);
      targetElement.innerHTML = '<div>Failed to load</div>';
    }
  }

  renderConfig(type, mode) {
    try {
      const currentConfig = this.configInstance.getConfig();
      const container = this.CONTAINERS[type - 1];
      if (!container) {
        throw new Error('Container not found');
      }

      let current;
      switch (type) {
        case 1:
          current = currentConfig['location-code'];
          break;
        case 2:
          current = currentConfig['realtime-station-id'];
          break;
        case 3:
          current = currentConfig['alert-level']?.['rts-intensity'];
          break;
        case 4:
          current = currentConfig['alert-level']?.['eew-intensity'];
          break;
      }

      const currentElement = container.querySelector(
        `.setting-option > .location > .current${mode === 'location' ? '' : ' > .warning-intensity'}`,
      );

      if (!currentElement) {
        throw new Error('Current element not found');
      }

      if (mode === 'location') {
        if (type === 1) {
          const location = this.codeToString(TREM.variable.region, current);
          currentElement.textContent = location
            ? `${location.city}${location.town}`
            : '';
        }
        else if (type === 2) {
          const stationInfo = this.station[current];
          const location = stationInfo?.info?.[stationInfo.info.length - 1];
          if (location) {
            const locationStr = this.codeToString(TREM.variable.region, location.code);
            currentElement.textContent = locationStr
              ? `${locationStr.city}${locationStr.town}-${current}`
              : '';
          }
          else {
            currentElement.textContent = '';
          }
        }
      }
      else {
        currentElement.className = currentElement.className
          .split(' ')
          .filter((cls) => !cls.startsWith('intensity-'))
          .join(' ');
        currentElement.classList.add(`intensity-${current || 0}`);
      }
    }
    catch (error) {
      this.logError('renderConfig error:', error);
    }
  }

  renderCurrent(target, type, mode) {
    try {
      if (type > 4) {
        throw new Error('Invalid type');
      }

      const container = this.CONTAINERS[type - 1];
      const currentElement = container.querySelector(
        `.setting-option > .location > .current${mode === 'location' ? '' : ' > .warning-intensity'}`,
      );

      if (mode === 'location') {
        if (type === 2) {
          const stationId = target.dataset.name;
          this.configInstance.writeConfig({
            ...this.configInstance.getConfig(),
            'realtime-station-id': stationId,
          });
          currentElement.textContent = `${target.dataset.loc}-${stationId}`;
        }
        else {
          currentElement.textContent = target.textContent;
        }
      }
      else {
        const intensityValue = target.dataset.id;
        currentElement.className = currentElement.className
          .split(' ')
          .filter((cls) => !cls.startsWith('intensity-'))
          .join(' ');
        currentElement.classList.add(`intensity-${intensityValue || 0}`);
      }
    }
    catch (error) {
      this.logError('renderCurrent error:', error);
    }
  }

  codeToString(region, code) {
    try {
      for (const [city, towns] of Object.entries(region)) {
        for (const [town, details] of Object.entries(towns)) {
          if (details.code === code) {
            return { city, town, ...details };
          }
        }
      }
      return null;
    }
    catch (error) {
      this.logError('codeToString error:', error);
      return null;
    }
  }

  log(...args) {
    if (this.debug) {
      logger.debug('[DropDown]', ...args);
    }
  }

  logError(...args) {
    logger.error('[DropDown Error]', ...args);
  }
}

new DropDown();

module.exports = DropDown;
