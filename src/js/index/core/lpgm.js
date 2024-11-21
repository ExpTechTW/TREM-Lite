TREM.variable.events.on('MapLoad', (map) => {
  map.addLayer({
    id: 'lpgm-markers',
    type: 'symbol',
    source: 'intensity-markers-geojson',
    layout: {
      'symbol-sort-key': ['get', 'i'],
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

TREM.variable.events.on('LpgmRelease', (ans) => show_lpgm(ans));
