const path = require('path');
const regionJson = require(path.join(__dirname, '../../resource/data', 'region.json'));
class Store {
  constructor() {
    this.station = [];
  }

  processStationData(data) {
    Object.entries(data).forEach(([station, { info = [], net = '未知' } = {}]) => {
      if (!info.length) {
        return;
      }

      const latestInfo = info.at(-1);
      if (latestInfo.code == 0) {
        return;
      }
      const loc = this.region_code_to_string(regionJson, latestInfo.code);
      console.log(loc);

      if (loc.city && !TREM.variable.city.includes(loc.city)) {
        TREM.variable.city.push(loc.city);
      }

      this.station.push({
        name: station,
        net,
        loc: loc.city ? `${loc.city}${loc.town}` : loc,
        code: latestInfo.code,
        lat: latestInfo.lat,
        lon: latestInfo.lon,
      });
    });

    return (TREM.variable.region = this.station);
  }

  region_code_to_string(region, code) {
    for (const city in region) {
      for (const town in region[city]) {
        if (region[city][town].code == code) {
          return { city, town, ...region[city][town] };
        }
      }
    }
    return null;
  }

  getFallbackLocation(station) {
    return TREM.constant.FallBack[station] || { city: '未知', town: '區域' };
  }

  CreatEle(text, className, bgText, html, attr) {
    const element = document.createElement('div');
    element.textContent = text;
    if (className) {
      element.classList = className;
    }
    if (bgText) {
      element.dataset.backgroundText = bgText;
    }
    if (html) {
      element.innerHTML = html;
    }
    if (attr) {
      Object.entries(attr).forEach(([key, value]) => {
        element.setAttribute(key, value);
      });
    }
    return element;
  }
}

module.exports = Store;
