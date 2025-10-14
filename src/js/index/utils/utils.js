const TREM = require('../constant');
const region = require('../../../resource/data/region.json');

const intensity_list = ['0', '1', '2', '3', '4', '5⁻', '5⁺', '6⁻', '6⁺', '7'];

function distance(latA, lngA) {
  return function (latB, lngB) {
    latA = latA * Math.PI / 180;
    lngA = lngA * Math.PI / 180;
    latB = latB * Math.PI / 180;
    lngB = lngB * Math.PI / 180;
    const sin_latA = Math.sin(Math.atan(Math.tan(latA)));
    const sin_latB = Math.sin(Math.atan(Math.tan(latB)));
    const cos_latA = Math.cos(Math.atan(Math.tan(latA)));
    const cos_latB = Math.cos(Math.atan(Math.tan(latB)));
    return Math.acos(sin_latA * sin_latB + cos_latA * cos_latB * Math.cos(lngA - lngB)) * 6371.008;
  };
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function search_loc_name(int) {
  for (const city of Object.keys(region)) {
    for (const town of Object.keys(region[city])) {
      if (region[city][town].code == int) {
        return { city, town };
      }
    }
  }
  return null;
}

function search_loc_code(str) {
  for (const city of Object.keys(region)) {
    for (const town of Object.keys(region[city])) {
      if (`${city}${town}` == str) {
        return region[city][town].code;
      }
    }
  }
  return null;
}

function formatTimestamp(Timestamp) {
  const date = new Date(Timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function intensity_float_to_int(float) {
  return float < 0 ? 0 : float < 4.5 ? Math.round(float) : float < 5 ? 5 : float < 5.5 ? 6 : float < 6 ? 7 : float < 6.5 ? 8 : 9;
}

function int_to_string(max) {
  return (max == 5) ? '5弱' : (max == 6) ? '5強' : (max == 7) ? '6弱' : (max == 8) ? '6強' : (max == 9) ? '7級' : `${max}級`;
}

function formatToChineseTime(dateTimeString) {
  const dateTime = new Date(dateTimeString);
  const hours = dateTime.getHours();
  const minutes = dateTime.getMinutes();
  const period = hours < 12 ? '早上' : '晚上';
  const formattedHours = hours <= 12 ? hours : hours - 12;
  const formattedMinutes = minutes < 10 ? `0${minutes}` : minutes;
  return `${period} ${formattedHours}點${formattedMinutes}分 左右`;
}

function extractLocation(loc) {
  const match = loc.match(/位於(.+)(?=\))/);
  return match ? match[1] : loc;
}

function createIntensityIconSquare(intensity, backgroundColor, textColor, strokeColor) {
  const svg = `
    <svg width="60" height="60" xmlns="http://www.w3.org/2000/svg">
      <rect 
        x="2" 
        y="2" 
        width="56" 
        height="56"
        rx="10"
        ry="10"
        fill="${backgroundColor}"
        stroke="${strokeColor}"
        stroke-width="3"
      />
      <text 
        x="30" 
        y="35"
        font-size="36"
        font-weight="bold"
        fill="${textColor}"
        text-anchor="middle"
        dominant-baseline="middle"
        font-family="Noto Sans TC, Manrope, sans-serif"
      >${intensity}</text>
    </svg>
  `;

  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  return img;
}

function createIntensityIcon(intensity, backgroundColor, textColor, strokeColor) {
  const svg = `
    <svg width="60" height="60" xmlns="http://www.w3.org/2000/svg">
      <circle 
        cx="30" 
        cy="30" 
        r="28" 
        fill="${backgroundColor}"
        stroke="${strokeColor}"
        stroke-width="3"
      />
      <text 
        x="30" 
        y="35"
        font-size="36"
        font-weight="bold"
        fill="${textColor}"
        text-anchor="middle"
        dominant-baseline="middle"
        font-family="Noto Sans TC, Manrope, sans-serif"
      >${intensity}</text>
    </svg>
  `;

  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  return img;
}

function generateMapStyle(eewArea, end = false, lpgm = false) {
  if (end) {
    return TREM.constant.COLOR.MAP.TW_COUNTY_FILL;
  }

  const matchExpression = ['match', ['get', 'CODE']];

  if (Object.keys(eewArea).length > 0) {
    Object.entries(eewArea).forEach(([code, intensity]) => {
      matchExpression.push(parseInt(code));
      matchExpression.push(
        intensity
          ? (lpgm) ? TREM.constant.COLOR.LPGM[intensity] : TREM.constant.COLOR.INTENSITY[intensity]
          : TREM.constant.COLOR.MAP.TW_COUNTY_FILL,
      );
    });
  }

  matchExpression.push(TREM.constant.COLOR.MAP.TW_TOWN_FILL);

  return matchExpression;
}

function convertIntensityToAreaFormat(intensityData) {
  const result = {};
  Object.entries(intensityData).forEach(([intensity, codes]) => {
    codes.forEach((code) => {
      result[code] = parseInt(intensity);
    });
  });
  return result;
}

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

module.exports = {
  formatTime,
  distance,
  formatTimestamp,
  search_loc_name,
  search_loc_code,
  intensity_float_to_int,
  int_to_string,
  formatToChineseTime,
  extractLocation,
  createIntensityIcon,
  createIntensityIconSquare,
  generateMapStyle,
  convertIntensityToAreaFormat,
  intensity_list,
  findMaxIntensityCity,
};
