const logger = require('../core/utils/logger');

const maplibregl = require('maplibre-gl');

const TREM = require('./constant');
const { createIntensityIcon, createIntensityIconSquare } = require('./utils/utils');

function initMap(delay = 3000) {
  return new Promise((resolve, reject) => {
    function attempt() {
      const map = new maplibregl.Map({
        container: 'map',
        style: {
          version: 8,
          name: 'ExpTech Studio',
          sources: {
            map: {
              type: 'vector',
              url: 'https://api-1.exptech.dev/api/v1/map/tiles/tiles.json',
              tileSize: 512,
              buffer: 64,
            },
          },
          sprite: '',
          glyphs: 'https://glyphs.geolonia.com/{fontstack}/{range}.pbf',
          layers: [
            {
              id: 'background',
              type: 'background',
              paint: {
                'background-color': TREM.constant.COLOR.MAP.BACKGROUND,
              },
            },
            {
              'id': 'county',
              'type': 'fill',
              'source': 'map',
              'source-layer': 'city',
              'paint': {
                'fill-color': TREM.constant.COLOR.MAP.TW_COUNTY_FILL,
                'fill-opacity': 1,
              },
            },
            {
              'id': 'town',
              'type': 'fill',
              'source': 'map',
              'source-layer': 'town',
              'paint': {
                'fill-color': TREM.constant.COLOR.MAP.TW_TOWN_FILL,
                'fill-opacity': 1,
              },
            },
            {
              'id': 'county-outline',
              'source': 'map',
              'source-layer': 'city',
              'type': 'line',
              'paint': {
                'line-color': TREM.constant.COLOR.MAP.TW_COUNTY_OUTLINE,
              },
            },
            {
              'id': 'global',
              'type': 'fill',
              'source': 'map',
              'source-layer': 'global',
              'paint': {
                'fill-color': TREM.constant.COLOR.MAP.GLOBAL_FILL,
                'fill-opacity': 1,
              },
            },
            {
              'id': 'tsunami',
              'type': 'line',
              'source': 'map',
              'source-layer': 'tsunami',
              'paint': {
                'line-opacity': 0,
                'line-width': 3,
              },
            },
          ],
        },
        center: [121.6, 23.5],
        zoom: 6.8,
        attributionControl: false,
        pitchWithRotate: false,
        dragRotate: false,
        maxZoom: 12,
        minZoom: 4,
      });

      map.on('load', () => resolve(map));

      map.on('error', (e) => {
        logger.error('Map loading error:', e);

        logger.warn(`Retrying... attempts remaining`);
        setTimeout(() => {
          attempt();
        }, delay);
      });
    }

    attempt();
  });
}

initMap()
  .then(async (map) => {
    logger.info('Map loaded successfully');

    map.on('resize', () => map.fitBounds(TREM.constant.MAP.BOUNDS, TREM.constant.MAP.OPTIONS));

    map.resize();
    map.fitBounds(TREM.constant.MAP.BOUNDS, TREM.constant.MAP.OPTIONS);

    const icons = [
      { id: '0', bg: TREM.constant.COLOR.INTENSITY[0], text: TREM.constant.COLOR.INTENSITY_TEXT[0], stroke: TREM.constant.COLOR.INTENSITY_TEXT[0] },
      { id: '1', bg: TREM.constant.COLOR.INTENSITY[1], text: TREM.constant.COLOR.INTENSITY_TEXT[1], stroke: TREM.constant.COLOR.INTENSITY_TEXT[1] },
      { id: '2', bg: TREM.constant.COLOR.INTENSITY[2], text: TREM.constant.COLOR.INTENSITY_TEXT[2], stroke: TREM.constant.COLOR.INTENSITY_TEXT[2] },
      { id: '3', bg: TREM.constant.COLOR.INTENSITY[3], text: TREM.constant.COLOR.INTENSITY_TEXT[3], stroke: TREM.constant.COLOR.INTENSITY_TEXT[3] },
      { id: '4', bg: TREM.constant.COLOR.INTENSITY[4], text: TREM.constant.COLOR.INTENSITY_TEXT[4], stroke: TREM.constant.COLOR.INTENSITY_TEXT[4] },
      { id: '5⁻', bg: TREM.constant.COLOR.INTENSITY[5], text: TREM.constant.COLOR.INTENSITY_TEXT[5], stroke: TREM.constant.COLOR.INTENSITY_TEXT[5] },
      { id: '5⁺', bg: TREM.constant.COLOR.INTENSITY[6], text: TREM.constant.COLOR.INTENSITY_TEXT[6], stroke: TREM.constant.COLOR.INTENSITY_TEXT[6] },
      { id: '6⁻', bg: TREM.constant.COLOR.INTENSITY[7], text: TREM.constant.COLOR.INTENSITY_TEXT[7], stroke: TREM.constant.COLOR.INTENSITY_TEXT[7] },
      { id: '6⁺', bg: TREM.constant.COLOR.INTENSITY[8], text: TREM.constant.COLOR.INTENSITY_TEXT[8], stroke: TREM.constant.COLOR.INTENSITY_TEXT[8] },
      { id: '7', bg: TREM.constant.COLOR.INTENSITY[9], text: TREM.constant.COLOR.INTENSITY_TEXT[9], stroke: TREM.constant.COLOR.INTENSITY_TEXT[9] },
    ];

    const lpgm_icons = [
      { id: '1', bg: TREM.constant.COLOR.LPGM[1], text: TREM.constant.COLOR.LPGM_TEXT[1], stroke: TREM.constant.COLOR.LPGM_TEXT[1] },
      { id: '2', bg: TREM.constant.COLOR.LPGM[2], text: TREM.constant.COLOR.LPGM_TEXT[2], stroke: TREM.constant.COLOR.LPGM_TEXT[2] },
      { id: '3', bg: TREM.constant.COLOR.LPGM[3], text: TREM.constant.COLOR.LPGM_TEXT[3], stroke: TREM.constant.COLOR.LPGM_TEXT[3] },
      { id: '4', bg: TREM.constant.COLOR.LPGM[4], text: TREM.constant.COLOR.LPGM_TEXT[4], stroke: TREM.constant.COLOR.LPGM_TEXT[4] },
    ];

    icons.forEach((icon, index) => {
      const image = createIntensityIcon(icon.id, icon.bg, icon.text, icon.stroke);

      image.onload = () => {
        map.addImage(`intensity-${index}`, image);
      };

      const image_square = createIntensityIconSquare(icon.id, icon.bg, icon.text, icon.stroke);

      image_square.onload = () => {
        map.addImage(`intensity-square-${index}`, image_square);
      };
    });

    lpgm_icons.forEach((icon) => {
      const image_square = createIntensityIconSquare(icon.id, icon.bg, icon.text, icon.stroke);

      image_square.onload = () => {
        map.addImage(`lpgm-${icon.id}`, image_square);
      };
    });

    map.addImage('gps', (await map.loadImage('../resource/image/gps.png')).data);
    map.addImage('cross', (await map.loadImage('../resource/image/cross.png')).data);
    map.addImage('cross1', (await map.loadImage('../resource/image/cross1.png')).data);
    map.addImage('cross2', (await map.loadImage('../resource/image/cross2.png')).data);
    map.addImage('cross3', (await map.loadImage('../resource/image/cross3.png')).data);
    map.addImage('cross4', (await map.loadImage('../resource/image/cross4.png')).data);

    TREM.variable.map = map;
    TREM.variable.events.emit('MapLoad', map);
  })
  .catch((error) => {
    logger.error('Final error:', error);
  });
