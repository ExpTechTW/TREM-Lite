const TREM = require('../constant');

const EEWCalculator = require('../utils/eewCalculator');

const { intensity_float_to_int, search_loc_name } = require('../utils/utils');
const show_eew = require('./eew');
const { showReportPoint } = require('./report');

const calculator = new EEWCalculator();

const rts_intensity_list = document.getElementById('rts-intensity-list');
const max_pga = document.getElementById('max-pga');
const max_intensity = document.getElementById('max-intensity');
const current_station_loc = document.getElementById('current-station-loc');
const current_station_pga = document.getElementById('current-station-pga');
const current_station_intensity = document.getElementById('current-station-intensity');
const current_station_intensity_text = document.getElementById('current-station-intensity-text');
const rts_info_trigger = document.getElementById('rts-info-trigger');
const rts_info_level = document.getElementById('rts-info-level');

const warning_box_unstable = document.getElementById('warning-box-unstable');
const Config = require('../../core/config');
const config = Config.getInstance().getConfig();

const level_list = {};

TREM.variable.events.on('MapLoad', (map) => {
  map.addSource('markers-geojson', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('markers-geojson-0', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('rts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'rts-layer',
    type: 'circle',
    source: 'rts',
    paint: {
      'circle-color': [
        'interpolate',
        ['linear'],
        ['get', 'i'],
        -3, TREM.constant.COLOR.RTS.intensity_3,
        -2, TREM.constant.COLOR.RTS.intensity_2,
        -1, TREM.constant.COLOR.RTS.intensity_1,
        0, TREM.constant.COLOR.RTS.intensity0,
        1, TREM.constant.COLOR.RTS.intensity1,
        2, TREM.constant.COLOR.RTS.intensity2,
        3, TREM.constant.COLOR.RTS.intensity3,
        4, TREM.constant.COLOR.RTS.intensity4,
        5, TREM.constant.COLOR.RTS.intensity5,
        6, TREM.constant.COLOR.RTS.intensity6,
        7, TREM.constant.COLOR.RTS.intensity7,
      ],
      'circle-radius': [
        'interpolate',
        ['linear'],
        ['zoom'],
        4, 2,
        12, 8,
      ],
    },
  });

  map.addLayer({
    id: 'markers-0',
    type: 'circle',
    source: 'markers-geojson-0',
    paint: {
      'circle-color': TREM.constant.COLOR.INTENSITY[0],
      'circle-radius': [
        'interpolate',
        ['linear'],
        ['zoom'],
        4, 2,
        12, 8,
      ],
    },
  });

  map.addLayer({
    id: 'markers',
    type: 'symbol',
    source: 'markers-geojson',
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
        'intensity-0',
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
});

TREM.variable.events.on('DataRts', (ans) => {
  let data_list = [];
  let data_alert_0_list = [];
  let data_alert_list = [];

  const coordinates = [];

  let pga = 0;
  let trigger = 0;
  let level = 0;
  let rts_max_pga = -1;
  let rts_max_shindo = -1;

  if (!TREM.variable.station) {
    return;
  }

  const eew_alert = (TREM.variable.data.eew.length && TREM.constant.SHOW_TREM_EEW) ? true : TREM.variable.data.eew.some((item) => item.author != 'trem');

  if (ans.data) {
    let alert = Object.keys(ans.data.box).length;

    let maxPgaKey = null;
    let maxPgaValue = -Infinity;
    let maxPgaStationData = null;

    for (const [key, data] of Object.entries(ans.data.station)) {
      if (data.pga > maxPgaValue) {
        maxPgaValue = data.pga;
        maxPgaKey = key;
        maxPgaStationData = data;
      }
    }

    if (!maxPgaStationData) {
      return;
    }

    alert = alert ? true : (maxPgaStationData.pga > TREM.constant.DEV_NSSPE.PGA_LEVEL && (TREM.constant.DEV_NSSPE.STATION.includes('all') || TREM.constant.DEV_NSSPE.STATION.includes(maxPgaKey))) ? true : false;

    if (!alert) {
      TREM.variable.cache.rts_alert = false;
      TREM.variable.cache.audio = {
        shindo: -1,
        pga: -1,
        status: {
          shindo: 0,
          pga: 0,
        },
        count: {
          pga_1: 0,
          pga_2: 0,
          shindo_1: 0,
          shindo_2: 0,
        },
      };
    }
    else {
      if (!TREM.variable.cache.rts_alert && TREM.variable.cache.last_rts_alert && (ans.data?.time ?? 0) - TREM.variable.cache.last_rts_alert < 300000) {
        TREM.variable.cache.unstable = ans.data.time;
      }
      TREM.variable.cache.last_rts_alert = ans.data?.time ?? 0;
      TREM.variable.cache.rts_alert = true;
    }

    for (const id of Object.keys(ans.data.station)) {
      const station_info = TREM.variable.station[id];
      if (!station_info) {
        continue;
      }

      ans.data.station[id].alert = ans.data.station[id].alert ? true : (ans.data.station[id].pga > TREM.constant.DEV_NSSPE.PGA_LEVEL && (TREM.constant.DEV_NSSPE.STATION.includes('all') || TREM.constant.DEV_NSSPE.STATION.includes(id))) ? true : false;

      const station_location = station_info.info.at(-1);

      if (ans.data.station[id].pga > pga) {
        pga = ans.data.station[id].pga;
      }

      if (id == config['realtime-station-id']) {
        const I = (alert && ans.data.station[id].alert) ? ans.data.station[id].I : ans.data.station[id].i;
        const loc = search_loc_name(station_location.code);
        current_station_loc.textContent = `${loc.city}${loc.town}`;
        current_station_pga.textContent = ans.data.station[id].pga.toFixed(2);
        current_station_intensity.className = `current-station-intensity intensity-${intensity_float_to_int(I)}`;
        current_station_intensity_text.textContent = I.toFixed(1);
      }

      if (ans.data.station[id].alert) {
        trigger++;
        if (!level_list[id] || level_list[id] < ans.data.station[id].pga) {
          level_list[id] = ans.data.station[id].pga;
        }
      }
      else {
        delete level_list[id];
      }

      if (alert && ans.data.station[id].alert) {
        const I = intensity_float_to_int(ans.data.station[id].I);

        if (TREM.variable.cache.show_intensity || TREM.variable.cache.show_lpgm) {
          data_list.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [station_location.lon, station_location.lat] }, properties: { i: I } });
        }
        else
          if (I > 0) {
            data_alert_list.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [station_location.lon, station_location.lat] }, properties: { i: I } });
          }
          else if (eew_alert && TREM.variable.data.eew) {
            data_alert_0_list.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [station_location.lon, station_location.lat] }, properties: {} });
          }
          else {
            data_list.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [station_location.lon, station_location.lat] }, properties: { i: I } });
          }

        coordinates.push({ lon: station_location.lon, lat: station_location.lat });

        if (rts_max_pga < ans.data.station[id].pga) {
          rts_max_pga = ans.data.station[id].pga;
        }
        if (rts_max_shindo < I) {
          rts_max_shindo = I;
        }

        if (pga > TREM.variable.cache.audio.pga) {
          if (pga > 200 && TREM.variable.cache.audio.status.pga != 2) {
            TREM.variable.events.emit('RtsPga2', ans.data);
            TREM.variable.cache.audio.status.pga = 2;
          }
          else if (pga > 8 && !TREM.variable.cache.audio.status.pga) {
            TREM.variable.events.emit('RtsPga1', ans.data);
            TREM.variable.cache.audio.status.pga = 1;
          }

          TREM.variable.cache.audio.pga = pga;
          if (pga > 8) {
            TREM.variable.cache.audio.count.pga_1 = 0;
          }
          if (pga > 200) {
            TREM.variable.cache.audio.count.pga_2 = 0;
          }
        }

        if (I > TREM.variable.cache.audio.shindo) {
          if (I > 3 && TREM.variable.cache.audio.status.shindo != 3) {
            TREM.variable.events.emit('RtsShindo2', ans.data);
            TREM.variable.cache.audio.status.shindo = 3;
          }
          else if (I > 1 && TREM.variable.cache.audio.status.shindo < 2) {
            TREM.variable.events.emit('RtsShindo1', ans.data);
            TREM.variable.cache.audio.status.shindo = 2;
          }
          else if (!TREM.variable.cache.audio.status.shindo) {
            TREM.variable.events.emit('RtsShindo0', ans.data);
            TREM.variable.cache.audio.status.shindo = 1;
          }

          if (I > 3) {
            TREM.variable.cache.audio.count.shindo_2 = 0;
          }
          if (I > 1) {
            TREM.variable.cache.audio.count.shindo_1 = 0;
          }
          TREM.variable.cache.audio.shindo = I;
        }
      }
      else if (!eew_alert) {
        data_list.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [station_location.lon, station_location.lat] }, properties: { i: ans.data.station[id].i } });
      }
    }

    if (TREM.variable.cache.audio.pga && rts_max_pga < TREM.variable.cache.audio.pga) {
      if (TREM.variable.cache.audio.status.pga == 2) {
        if (rts_max_pga < 200) {
          TREM.variable.cache.audio.count.pga_2++;
          if (TREM.variable.cache.audio.count.pga_2 >= 30) {
            TREM.variable.cache.audio.count.pga_2 = 0;
            TREM.variable.cache.audio.status.pga = 1;
          }
        }
        else {
          TREM.variable.cache.audio.count.pga_2 = 0;
        }
      }

      else if (TREM.variable.cache.audio.status.pga == 1) {
        if (rts_max_pga < 8) {
          TREM.variable.cache.audio.count.pga_1++;
          if (TREM.variable.cache.audio.count.pga_1 >= 30) {
            TREM.variable.cache.audio.count.pga_1 = 0;
            TREM.variable.cache.audio.status.pga = 0;
          }
        }
        else {
          TREM.variable.cache.audio.count.pga_1 = 0;
        }
      }

      TREM.variable.cache.audio.pga = rts_max_pga;
    }

    if (TREM.variable.cache.audio.shindo && rts_max_shindo < TREM.variable.cache.audio.shindo) {
      if (TREM.variable.cache.audio.status.shindo == 3) {
        if (rts_max_shindo < 4) {
          TREM.variable.cache.audio.count.shindo_2++;
          if (TREM.variable.cache.audio.count.shindo_2 >= 15) {
            TREM.variable.cache.audio.count.shindo_2 = 0;
            TREM.variable.cache.audio.status.shindo = 2;
          }
        }
        else {
          TREM.variable.cache.audio.count.shindo_2 = 0;
        }
      }

      else if (TREM.variable.cache.audio.status.shindo == 2) {
        if (rts_max_shindo < 2) {
          TREM.variable.cache.audio.count.shindo_1++;
          if (TREM.variable.cache.audio.count.shindo_1 >= 15) {
            TREM.variable.cache.audio.count.shindo_1 = 0;
            TREM.variable.cache.audio.status.shindo = 1;
          }
        }
        else {
          TREM.variable.cache.audio.count.shindo_1 = 0;
        }
      }

      TREM.variable.cache.audio.shindo = rts_max_shindo;
    }

    if (((ans.data?.time ?? 0) - TREM.variable.cache.last_rts_alert < 15000) || TREM.variable.cache.show_lpgm || TREM.variable.cache.show_intensity || eew_alert || (TREM.variable.play_mode == 2 || TREM.variable.play_mode == 3)) {
      if (TREM.variable.cache.bounds.report) {
        TREM.variable.cache.bounds.report = [];
        TREM.variable.map.getSource('report-markers-geojson').setData({ type: 'FeatureCollection', features: [] });
      }
    }
    else {
      if (TREM.constant.SHOW_REPORT) {
        data_list = [];
        data_alert_0_list = [];
        data_alert_list = [];
        if (!TREM.variable.cache.bounds.report.length || !TREM.class.FocusManager?.getInstance().getLock()) {
          showReportPoint(TREM.variable.cache.last_report);
        }
      }
    }
  }

  if (TREM.variable.map) {
    TREM.variable.map.getSource('rts').setData({ type: 'FeatureCollection', features: data_list });
    TREM.variable.map.getSource('markers-geojson').setData({ type: 'FeatureCollection', features: data_alert_list });
    TREM.variable.map.getSource('markers-geojson-0').setData({ type: 'FeatureCollection', features: data_alert_0_list });
  }

  const int_list = ans.data?.int ?? [];

  const box_list = getTopIntensities(
    updateIntensityHistory(int_list, ans.data?.time ?? 0),
  ).sort((a, b) => b.i - a.i)
    .map((loc) => intensity_item(loc.i, loc.name));

  if (int_list.length) {
    TREM.variable.cache.rts_trigger.loc = getTopIntensities(filterIntArray(int_list), 8);
    TREM.variable.cache.rts_trigger.max = int_list[0].i;
    show_eew(false);
  }
  else {
    TREM.variable.cache.rts_trigger.loc = [];
  }

  const alert = (!ans.data?.box) ? false : Object.keys(ans.data.box).length;

  rts_intensity_list.replaceChildren(...box_list);

  max_pga.textContent = `${pga.toFixed(2)} gal`;
  max_pga.className = `max-station-pga ${(!alert) ? 'intensity-0' : `intensity-${pga < 5 ? '0' : calculator.pgaToIntensity(pga)}`}`;
  max_intensity.className = `max-station-intensity intensity-${int_list[0]?.i ?? 0}`;

  for (const id of Object.keys(level_list)) {
    level += level_list[id];
  }

  rts_info_level.textContent = Math.round(level);
  rts_info_trigger.textContent = trigger;

  TREM.variable.cache.bounds.rts = coordinates;

  if (TREM.variable.cache.unstable && (ans.data?.time ?? 0) - TREM.variable.cache.unstable < 300000) {
    if (warning_box_unstable.classList.contains('hide')) {
      warning_box_unstable.classList.remove('hide');
    }
  }
  else {
    if (!warning_box_unstable.classList.contains('hide')) {
      warning_box_unstable.classList.add('hide');
    }
  }
});

function filterIntArray(data = []) {
  const maxValue = data[0].i;

  if (maxValue > 3) {
    return data.filter((value) => value.i > 3);
  }
  else if (maxValue > 1) {
    return data.filter((value) => value.i > 1);
  }

  return data;
}

function updateIntensityHistory(newData, time) {
  const updatedCodes = new Set();

  for (const int of newData) {
    updatedCodes.add(int.code);

    if (!TREM.variable.cache.int_cache_list[int.code]) {
      TREM.variable.cache.int_cache_list[int.code] = {
        values: [],
        lastUpdate: time,
      };
    }

    TREM.variable.cache.int_cache_list[int.code].values.push(int.i);
    TREM.variable.cache.int_cache_list[int.code].lastUpdate = time;

    if (TREM.variable.cache.int_cache_list[int.code].values.length > 45) {
      TREM.variable.cache.int_cache_list[int.code].values.shift();
    }
  }

  const cutoff = time - 30000;
  Object.keys(TREM.variable.cache.int_cache_list).forEach((code) => {
    if (TREM.variable.cache.int_cache_list[code].lastUpdate < cutoff) {
      delete TREM.variable.cache.int_cache_list[code];
    }
  });

  const maxIntensities = Object.entries(TREM.variable.cache.int_cache_list).map(([code, data]) => ({
    code: code,
    i: Math.max(...data.values),
  }));

  return maxIntensities;
}

function getTopIntensities(intensities, maxCount = 6) {
  if (intensities.length <= maxCount) {
    return intensities.map((loc) => {
      const name = search_loc_name(loc.code);
      return {
        i: loc.i,
        name: name ? `${name.city}${name.town}` : '',
      };
    });
  }

  const cityGroups = new Map();
  intensities.forEach((loc) => {
    const name = search_loc_name(loc.code);
    if (!name) {
      return;
    }

    const current = cityGroups.get(name.city);
    if (!current || loc.i > current.i) {
      cityGroups.set(name.city, {
        i: loc.i,
        name: name.city,
      });
    }
  });

  return Array.from(cityGroups.values())
    .sort((a, b) => b.i - a.i)
    .slice(0, maxCount);
}

function intensity_item(i, loc) {
  const box = document.createElement('div');
  box.className = 'rts-intensity-item';

  const intensity = document.createElement('div');
  intensity.className = `rts-intensity intensity-${i}`;

  const location = document.createElement('div');
  location.className = 'rts-loc';
  location.textContent = loc;

  box.append(intensity, location);
  return box;
}
