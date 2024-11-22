class Store {
  constructor() {
    this.path = require('path');
    TREM.variable.region = require(this.path.join(__dirname, '../../resource/data/region.json'));
    this.station = [];
  }

  processStation(data) {
    TREM.variable.city = TREM.variable.city || [];
    Object.entries(data).forEach(([station, { info = [], net = '未知' } = {}]) => {
      const latestInfo = info.at(-1);
      if (!latestInfo || latestInfo.code === 0) {
        return;
      }
      const loc = this.codeToString(TREM.variable.region, latestInfo.code);
      if (loc?.city && !TREM.variable.city.some((city) => city.city === loc.city)) {
        TREM.variable.city.push({ code: loc.code, city: loc.city });
      }
      this.station.push({
        name: station,
        net,
        loc: loc?.city ? `${loc.city}${loc.town}` : loc,
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
