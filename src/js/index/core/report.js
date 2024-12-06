const fetchData = require('../../core/utils/fetch');
const TREM = require('../constant');
const { extractLocation } = require('../utils/utils');
const crypto = require('crypto');
const { updateMapBounds } = require('./focus');
const { ipcRenderer } = require('electron');
const { stopReplay, startReplay } = require('./replay');

let last_replay_time = 0;

class ReportManager {
  static instance = null;

  constructor() {
    if (ReportManager.instance) {
      return ReportManager.instance;
    }
    this.closeButton = document.querySelector('#close-btn');
    this.reportWrapper = document.querySelector('.report-wrapper');
    this.reportBoxItems = document.querySelector('.report-box-items');
    this.customScrollbar = document.querySelector('.custom-scrollbar');
    this.isClose = false;
    this.isDragging = false;
    this.currentFlashingId = null;
    this.startY = 0;
    this.initialScrollTop = 0;
    this.bindEvents();
    ReportManager.instance = this;
  }

  static getInstance() {
    if (!ReportManager.instance) {
      new ReportManager();
    }
    return ReportManager.instance;
  }

  bindEvents() {
    this.closeButton.addEventListener('click', () => this.toggleReport());

    this.reportBoxItems.addEventListener('scroll', () => this.updateScrollbar());
    this.reportBoxItems.addEventListener('wheel', (e) => this.onScroll(e));
    this.customScrollbar.addEventListener('mousedown', (e) => this.onDragStart(e));
    document.addEventListener('mousemove', (e) => this.onDragMove(e));
    document.addEventListener('mouseup', () => this.onDragEnd());
    window.addEventListener('resize', () => this.updateScrollbar());

    TREM.variable.events.on('MapLoad', (map) => this.onMapLoad(map));
    TREM.variable.events.on('ReportRelease', (ans) => this.onReportRelease(ans));
  }

  onMapLoad(map) {
    this.initializeMapLayers(map);
    setInterval(() => this.refresh(), 10000);
    this.refresh();
  }

  initializeMapLayers(map) {
    map.addSource('report-markers-geojson', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    map.addLayer({
      id: 'report-markers',
      type: 'symbol',
      source: 'report-markers-geojson',
      filter: ['!=', ['get', 'i'], 0],
      layout: {
        'symbol-sort-key': ['get', 'i'],
        'symbol-z-order': 'source',
        'icon-image': [
          'match',
          ['get', 'i'],
          1, 'intensity-1',
          2, 'intensity-2',
          3, 'intensity-3',
          4, 'intensity-4',
          5, 'intensity-5',
          6, 'intensity-6',
          7, 'intensity-7',
          8, 'intensity-8',
          9, 'intensity-9',
          'cross',
        ],
        'icon-size': [
          'interpolate',
          ['linear'],
          ['zoom'],
          5, 0.2,
          10, 0.6,
        ],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });

    map.addLayer({
      id: 'report-markers-cross',
      type: 'symbol',
      source: 'report-markers-geojson',
      filter: ['==', ['get', 'i'], 0],
      layout: {
        'symbol-sort-key': ['get', 'i'],
        'symbol-z-order': 'source',
        'icon-image': 'cross',
        'icon-size': [
          'interpolate',
          ['linear'],
          ['zoom'],
          5, 0.01,
          10, 0.09,
        ],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });
  }

  toggleReport() {
    this.closeButton.classList.toggle('off');
    this.reportWrapper.classList.toggle('hidden');
    this.isClose = !this.isClose;
  }

  updateScrollbar() {
    const { scrollHeight, clientHeight, scrollTop } = this.reportBoxItems;
    const maxScrollbarTop = clientHeight - this.customScrollbar.clientHeight - 8;
    this.customScrollbar.style.height = `${Math.max((clientHeight / scrollHeight) * clientHeight, 30)}px`;
    this.customScrollbar.style.top = `${(scrollTop / (scrollHeight - clientHeight)) * maxScrollbarTop}px`;
  }

  onScroll(event) {
    this.reportBoxItems.scrollTop += event.deltaY;
    this.updateScrollbar();
  }

  onDragStart(e) {
    this.isDragging = true;
    this.startY = e.clientY;
    this.initialScrollTop = this.reportBoxItems.scrollTop;
    document.body.style.userSelect = 'none';
  }

  onDragMove(e) {
    if (!this.isDragging) {
      return;
    }
    const deltaY = e.clientY - this.startY;
    const scrollRatio = deltaY / (this.reportBoxItems.clientHeight - this.customScrollbar.clientHeight);
    this.reportBoxItems.scrollTop = this.initialScrollTop + scrollRatio * (this.reportBoxItems.scrollHeight - this.reportBoxItems.clientHeight);
  }

  onDragEnd() {
    this.isDragging = false;
    document.body.style.userSelect = '';
  }

  formatTime(timestamp) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  createIntensityBox(intensity = '0') {
    const box = document.createElement('div');
    box.className = 'report-intensity-box';

    const val = document.createElement('div');
    val.className = `report-intensity-val intensity-${intensity}`;

    const text = document.createElement('div');
    text.className = 'report-intensity-text';

    box.appendChild(val);
    box.appendChild(text);
    return box;
  }

  createInfoBox(item, isSurvey = false) {
    const box = document.createElement('div');
    box.className = 'report-info-box';

    const infoItem = document.createElement('div');
    infoItem.className = 'report-info-item';

    const loc = document.createElement('div');
    loc.className = 'report-loc';
    if (!isSurvey && item.loc) {
      loc.textContent = extractLocation(item.loc);
    }

    const time = document.createElement('div');
    time.className = 'report-time';
    time.textContent = this.formatTime(item.time);

    infoItem.appendChild(loc);
    infoItem.appendChild(time);

    const magDep = document.createElement('div');
    magDep.className = 'report-mag-dep';

    const mag = document.createElement('div');
    mag.className = 'report-mag';
    const magText = document.createElement('div');
    magText.className = 'report-mag-text';
    const magVal = document.createElement('div');
    magVal.className = 'report-mag-val';
    magVal.textContent = item.mag ? item.mag.toFixed(1) : '';
    magVal.classList.add(item.id.split('-')[0] !== '113000' ? 'isNum' : null);

    mag.appendChild(magText);
    mag.appendChild(magVal);

    const depth = document.createElement('div');
    depth.className = 'report-depth';
    const depthText = document.createElement('div');
    depthText.className = 'report-depth-text';
    const depthVal = document.createElement('div');
    depthVal.className = 'report-depth-val';
    depthVal.textContent = item.depth || '';
    depth.appendChild(depthText);
    depth.appendChild(depthVal);

    magDep.appendChild(mag);
    magDep.appendChild(depth);
    box.appendChild(infoItem);
    box.appendChild(magDep);

    return box;
  }

  createReportItem(item, isSurvey = false, url = '') {
    const wrapper = document.createElement('div');
    wrapper.className = `report-box-item-wrapper${isSurvey ? ' survey' : ''}`;
    wrapper.setAttribute('data-id', item.id);
    wrapper.setAttribute('trem-url', (item.trem) ? `https://${url}/file/trem_info.html?id=${item.trem}` : '');
    wrapper.setAttribute('data-time', item.time);
    const contain = document.createElement('div');
    contain.className = 'report-box-item-contain';
    const buttons = document.createElement('div');
    buttons.className = 'report-buttons';
    const webButton = document.createElement('div');
    webButton.className = `report-web ${(item.trem) ? 'web-detection' : 'web-report'}`;
    const replayButton = document.createElement('div');
    replayButton.className = 'report-replay';

    contain.appendChild(this.createIntensityBox(item.int));
    contain.appendChild(this.createInfoBox(item, isSurvey));
    wrapper.appendChild(contain);
    buttons.appendChild(webButton);
    buttons.appendChild(replayButton);
    wrapper.appendChild(buttons);
    return wrapper;
  }

  clickEvent() {
    const stopFlashing = () => {
      document.querySelectorAll('.flashing').forEach((el) => {
        el.classList.remove('flashing');
      });
      this.currentFlashingId = null;
    };

    this.reportWebButtons = document.querySelectorAll('.report-web');
    this.reportWebButtons.forEach((button) => {
      button.addEventListener('click', (event) => {
        const wrapper = event.target.closest('.report-box-item-wrapper');
        if (wrapper) {
          const id = wrapper.getAttribute('data-id');
          const trem = wrapper.getAttribute('trem-url');
          const reportId = id.replace(`-${id.split('-')[1]}`, '');
          const url = (trem) ? trem : `https://www.cwa.gov.tw/V8/C/E/EQ/EQ${reportId}.html`;
          ipcRenderer.send('openUrl', url);
        }
      });
    });

    this.reportReplyButtons = document.querySelectorAll('.report-replay');
    this.reportReplyButtons.forEach((button) => {
      button.addEventListener('click', async (event) => {
        const wrapper = event.target.closest('.report-box-item-wrapper');
        const time = Number(wrapper.getAttribute('data-time')) - 5000;
        const itemId = wrapper.getAttribute('data-id');

        stopReplay();

        if (last_replay_time == time) {
          last_replay_time = 0;
          stopFlashing();
          return;
        }

        last_replay_time = time;
        startReplay(time);

        stopFlashing();
        wrapper.classList.add('flashing');
        this.currentFlashingId = itemId;
      });
    });
  }

  now(time) {
    if (!TREM.variable.replay.local_time) {
      TREM.variable.replay.local_time = Date.now();
    }
    return Number(time) + (Date.now() - TREM.variable.replay.local_time);
  }

  generateReportBoxItems(list, survey = null, url = '') {
    const container = document.getElementById('report-box-items');
    if (!container) {
      return;
    }

    const currentFlashingElement = document.querySelector('.flashing');
    const currentFlashingTime = currentFlashingElement
      ? Number(currentFlashingElement.getAttribute('data-time'))
      : null;

    container.innerHTML = '';

    if (survey) {
      const surveyItem = {
        int: survey.intensity || 0,
        loc: '',
        time: survey.time,
        mag: '',
        depth: '',
        id: 'survey-item',
      };
      container.appendChild(this.createReportItem(surveyItem, true));
    }

    list.forEach((item) => {
      container.appendChild(this.createReportItem(item, false, url));
    });

    this.clickEvent();

    if (this.currentFlashingId && last_replay_time !== 0) {
      const itemToFlash = container.querySelector(`[data-id="${this.currentFlashingId}"]`);

      if (itemToFlash && currentFlashingTime) {
        const itemTime = Number(itemToFlash.getAttribute('data-time'));
        if (itemTime === currentFlashingTime) {
          itemToFlash.classList.add('flashing');
        }
        else {
          this.currentFlashingId = null;
          last_replay_time = 0;
        }
      }
    }

    this.updateScrollbar();
  }

  async getReport(url) {
    const ans = await fetchData(
      `https://${url}/api/v2/eq/report?limit=${TREM.constant.REPORT_LIMIT}`,
      TREM.constant.HTTP_TIMEOUT.REPORT,
    );
    if (!ans || !ans.ok) {
      return null;
    }
    return await ans.json();
  }

  async getReportInfo(url, id) {
    const ans = await fetchData(
      `https://${url}/api/v2/eq/report/${id}`,
      TREM.constant.HTTP_TIMEOUT.REPORT,
    );
    if (!ans || !ans.ok) {
      return null;
    }
    return await ans.json();
  }

  async refresh() {
    const url = TREM.constant.URL.API[Math.floor(Math.random() * TREM.constant.URL.API.length)];
    const reportList = await this.getReport(url);
    if (!reportList) {
      return;
    }

    if (!TREM.variable.data.report.length) {
      TREM.variable.data.report = reportList;
      if (TREM.constant.SHOW_REPORT) {
        const data = await this.getReportInfo(url, reportList[0].id);
        TREM.variable.cache.last_report = data;
      }
      this.generateReportBoxItems(
        TREM.variable.data.report,
        TREM.variable.cache.intensity.time
          ? {
              time: TREM.variable.cache.intensity.time,
              intensity: TREM.variable.cache.intensity.max,
            }
          : null,
        url,
      );
      return;
    }

    const existingIds = new Set(TREM.variable.data.report.map((item) => item.id));
    const newReports = reportList.filter((report) => !existingIds.has(report.id));

    if (newReports.length > 0) {
      const data = await this.getReportInfo(url, newReports[0].id);
      if (data) {
        TREM.variable.events.emit('ReportRelease', { info: { url }, data });
      }
    }
  }

  simplifyEarthquakeData(data) {
    let maxIntensity = 0;
    Object.values(data.list).forEach((county) => {
      if (county.int > maxIntensity) {
        maxIntensity = county.int;
      }
    });

    const earthquakeData = {
      id: data.id,
      lat: data.lat,
      lon: data.lon,
      depth: data.depth,
      loc: data.loc,
      mag: data.mag,
      time: data.time,
      int: maxIntensity,
      eq_list: data.list,
      trem: data.trem,
    };

    const md5Value = crypto
      .createHash('md5')
      .update(JSON.stringify(earthquakeData))
      .digest('hex')
      .toUpperCase();

    return {
      ...earthquakeData,
      md5: md5Value,
    };
  }

  showReportPoint(data) {
    if (!data) {
      return;
    }

    const dataList = [];

    for (const city of Object.keys(data.list)) {
      for (const town of Object.keys(data.list[city].town)) {
        const info = data.list[city].town[town];
        TREM.variable.cache.bounds.report.push({ lon: info.lon, lat: info.lat });
        dataList.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [info.lon, info.lat] },
          properties: { i: info.int },
        });
      }
    }

    dataList.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [data.lon, data.lat] },
      properties: { i: 0 },
    });

    updateMapBounds(TREM.variable.cache.bounds.report);
    TREM.variable.map.getSource('report-markers-geojson').setData({
      type: 'FeatureCollection',
      features: dataList,
    });
  }

  onReportRelease(ans) {
    if (TREM.constant.SHOW_REPORT) {
      TREM.variable.cache.last_report = ans.data;
      this.showReportPoint(ans.data);
    }

    const data = this.simplifyEarthquakeData(ans.data);
    TREM.variable.data.report.unshift(data);

    if (data.trem && Math.abs(data.trem - TREM.variable.cache.intensity.time) < 5000) {
      TREM.variable.cache.intensity.time = 0;
      TREM.variable.cache.intensity.max = 0;
    }

    this.generateReportBoxItems(
      TREM.variable.data.report,
      TREM.variable.cache.intensity.time
        ? {
            time: TREM.variable.cache.intensity.time,
            intensity: TREM.variable.cache.intensity.max,
          }
        : null,
      ans.info.url,
    );
  }
}

TREM.class.ReportManager = ReportManager;

const reportManager = ReportManager.getInstance();

if (window.innerWidth < 1080) {
  reportManager.toggleReport();
}

reportManager.updateScrollbar();

module.exports = {
  generateReportBoxItems: (list, survey) => reportManager.generateReportBoxItems(list, survey),
  show_report_point: (data) => reportManager.showReportPoint(data),
};
