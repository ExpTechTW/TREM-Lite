const region = require('../../../resource/data/region.json');

const TREM = require('../constant');
const { generateMapStyle, convertIntensityToAreaFormat, int_to_string, search_loc_name } = require('../utils/utils');
const drawEewArea = require('./estimate');
const { focus } = require('./focus');
const { generateReportBoxItems } = require('./report');

TREM.variable.events.on('MapLoad', (map) => {
  map.addSource('intensity-markers-geojson', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  map.addLayer({
    id: 'intensity-markers',
    type: 'symbol',
    source: 'intensity-markers-geojson',
    layout: {
      'symbol-sort-key': ['get', 'i'],
      'symbol-z-order': 'source',
      'icon-image': [
        'match',
        ['get', 'i'],
        1, 'intensity-square-1',
        2, 'intensity-square-2',
        3, 'intensity-square-3',
        4, 'intensity-square-4',
        5, 'intensity-square-5',
        6, 'intensity-square-6',
        7, 'intensity-square-7',
        8, 'intensity-square-8',
        9, 'intensity-square-9',
        'intensity-square-0',
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

function show_intensity(ans) {
  const data_list = [];
  const bounds = [];

  const city_intensity_list = findMaxIntensityCity(ans.data.area);

  TREM.variable.cache.show_intensity = true;

  TREM.variable.events.emit('DataRts', {
    info: {
      type: TREM.variable.play_mode,
    },
    data: TREM.variable.data.rts,
  });

  TREM.variable.cache.intensity.time = ans.data.id;
  if (TREM.variable.cache.intensity.max < ans.data.max) {
    TREM.variable.speech.speak({ text: `震度速報，震度${int_to_string(city_intensity_list.intensity).replace('級', '')}，${city_intensity_list.cities.join('、')}`, queue: true });
  }
  TREM.variable.cache.intensity.max = ans.data.max;

  generateReportBoxItems(TREM.variable.data.report, TREM.variable.cache.intensity.time ? { time: TREM.variable.cache.intensity.time, intensity: TREM.variable.cache.intensity.max } : null);

  const code_intensity = convertIntensityToAreaFormat(ans.data.area);

  const mapStyle = generateMapStyle(code_intensity);
  TREM.variable.map.setPaintProperty('town', 'fill-color', mapStyle);
  TREM.variable.map.setPaintProperty('rts-layer', 'circle-opacity', 0.2);

  for (const code of Object.keys(code_intensity)) {
    const loc = search_loc_name(code);
    if (!loc) {
      continue;
    }
    const loc_info = region[loc.city][loc.town];
    bounds.push({ lon: loc_info.lon, lat: loc_info.lat });
    data_list.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [loc_info.lon, loc_info.lat] }, properties: { i: code_intensity[code] } });
  }

  TREM.variable.cache.bounds.intensity = bounds;

  TREM.variable.map.getSource('intensity-markers-geojson').setData({ type: 'FeatureCollection', features: data_list });

  setTimeout(() => {
    TREM.variable.cache.show_intensity = false;
    TREM.variable.events.emit('DataRts', {
      info: {
        type: TREM.variable.play_mode,
      },
      data: TREM.variable.data.rts,
    });
    TREM.variable.cache.bounds.intensity = [];
    if (!TREM.class.FocusManager?.getInstance().getLock()) {
      focus();
    }
    TREM.variable.map.setPaintProperty('rts-layer', 'circle-opacity', 1);
    TREM.variable.map.getSource('intensity-markers-geojson').setData({ type: 'FeatureCollection', features: [] });
    drawEewArea();
  }, 7500);
}

TREM.variable.events.on('IntensityRelease', (ans) => show_intensity(ans));
TREM.variable.events.on('IntensityUpdate', (ans) => show_intensity(ans));

TREM.variable.events.on('IntensityEnd', () => {
  TREM.variable.cache.intensity.time = 0;
  TREM.variable.cache.intensity.max = 0;
  generateReportBoxItems(TREM.variable.data.report, TREM.variable.cache.intensity.time ? { time: TREM.variable.cache.intensity.time, intensity: TREM.variable.cache.intensity.max } : null);
  drawEewArea();
});

function findMaxIntensityCity(eqArea) {
  if (!eqArea || Object.keys(eqArea).length === 0) {
    return null;
  }

  const maxIntensity = Math.max(...Object.keys(eqArea).map(Number));

  const maxIntensityCodes = eqArea[maxIntensity] || [];

  const citiesWithMaxIntensity = maxIntensityCodes
    .map((code) => search_loc_name(parseInt(code)))
    .filter((location) => location !== null)
    .map((location) => location.city);

  const uniqueCities = [...new Set(citiesWithMaxIntensity)];

  return {
    intensity: maxIntensity,
    cities: uniqueCities,
  };
}
