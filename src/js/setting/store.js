class Store {
  constructor() {
    this.station = [];
    this.path = require('path');
    TREM.variable.region = require(this.path.join(__dirname, '../../resource/data', 'region.json'));
  }

  processStation(data) {
    Object.entries(data).forEach(([station, { info = [], net = '未知' } = {}]) => {
      if (!info.length || info.at(-1).code === 0) {
        return;
      }
      const latestInfo = info.at(-1);
      const loc = this.codeToString(TREM.variable.region, latestInfo.code);
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
    return (TREM.variable.station = this.station);
  }

  codeToString(region, code) {
    for (const [city, towns] of Object.entries(region)) {
      for (const [town, details] of Object.entries(towns)) {
        if (details.code === code) {
          return { city, town, ...details };
        }
      }
    }
    return null;
  }
}

module.exports = Store;
