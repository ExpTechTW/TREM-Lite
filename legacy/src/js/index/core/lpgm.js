const TREM = require('../constant');

const { generateMapStyle, search_loc_name } = require('../utils/utils');
const drawEewArea = require('./estimate');

TREM.variable.events.on('MapLoad', (map) => {
  map.addSource('lpgm-markers-geojson', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  map.addLayer({
    id: 'lpgm-markers',
    type: 'symbol',
    source: 'lpgm-markers-geojson',
    layout: {
      'symbol-sort-key': [
        'match',
        ['get', 'i'],
        4, -4,
        3, -3,
        2, -2,
        -1,
      ],
      'symbol-z-order': 'source',
      'icon-image': [
        'match',
        ['get', 'i'],
        2, 'lpgm-2',
        3, 'lpgm-3',
        4, 'lpgm-4',
        'lpgm-1',
      ],
      'icon-size': [
        'interpolate',
        ['linear'],
        ['zoom'],
        5, 0.3,
        10, 0.7,
      ],
    },
  });
});

function show_lpgm(ans) {
  TREM.variable.map.getSource('intensity-markers-geojson').setData({ type: 'FeatureCollection', features: [] });
  TREM.variable.cache.bounds.intensity = [];
  TREM.variable.cache.show_intensity = false;

  const data_list = [];
  const bounds = [];
  const code_intensity = {};
  let max = 0;
  let max_city = [];

  TREM.variable.cache.show_lpgm = true;

  TREM.variable.events.emit('DataRts', {
    info: {
      type: TREM.variable.play_mode,
    },
    data: TREM.variable.data.rts,
  });

  for (const station of ans.data.list) {
    if (!station.lpgm) {
      continue;
    }

    const station_info = TREM.variable.station[station.id];
    if (!station_info) {
      continue;
    }
    const station_location = station_info.info.at(-1);

    const loc = search_loc_name(station_location.code);

    if (loc && station.lpgm >= max) {
      if (station.lpgm > max) {
        max_city = [];
      }
      max = station.lpgm;
      max_city.push(loc.city);
    }

    if (!code_intensity[station_location.code]) {
      code_intensity[station_location.code] = 0;
    }

    if (code_intensity[station_location.code] < station.lpgm) {
      code_intensity[station_location.code] = station.lpgm;
    }

    bounds.push({ lon: station_location.lon, lat: station_location.lat });
    data_list.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [station_location.lon, station_location.lat] }, properties: { i: station.lpgm } });
  }

  const mapStyle = generateMapStyle(code_intensity, false, true);
  TREM.variable.map.setPaintProperty('town', 'fill-color', mapStyle);
  TREM.variable.map.setPaintProperty('rts-layer', 'circle-opacity', 0.2);

  TREM.variable.cache.bounds.lpgm = bounds;

  focus();

  TREM.variable.map.getSource('lpgm-markers-geojson').setData({ type: 'FeatureCollection', features: data_list });

  setTimeout(() => {
    if (!TREM.variable.cache.show_lpgm) {
      return;
    }
    TREM.variable.cache.show_lpgm = false;
    TREM.variable.events.emit('DataRts', {
      info: {
        type: TREM.variable.play_mode,
      },
      data: TREM.variable.data.rts,
    });
    TREM.variable.cache.bounds.lpgm = [];
    if (!TREM.class.FocusManager?.getInstance().getLock()) {
      focus();
    }
    TREM.variable.map.setPaintProperty('rts-layer', 'circle-opacity', 1);
    TREM.variable.map.getSource('lpgm-markers-geojson').setData({ type: 'FeatureCollection', features: [] });
    drawEewArea();
  }, 15000);
}

TREM.variable.events.on('LpgmRelease', (ans) => show_lpgm(ans));
