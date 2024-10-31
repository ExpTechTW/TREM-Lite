const region = require("../../resource/data/region.json");
class EEWCalculator {
  constructor(timeTable) {
    this.timeTable = timeTable;
    this.ln10 = Math.log(10);
  }

  psWaveDist(depth, time, now) {
    let pDist = 0;
    let sDist = 0;
    let sT = 0;

    const t = (now - time) / 1000.0;

    const depthKey = this.findClosest(
      Object.keys(this.timeTable).map(Number),
      depth,
    ).toString();

    const timeTable = this.timeTable[depthKey];
    let prevTable = null;

    for (const table of timeTable) {
      if (pDist === 0 && table.P > t)
        if (prevTable) {
          const tDiff = table.P - prevTable.P;
          const rDiff = table.R - prevTable.R;
          const tOffset = t - prevTable.P;
          const rOffset = (tOffset / tDiff) * rDiff;
          pDist = prevTable.R + rOffset;
        } else
          pDist = table.R;


      if (sDist === 0 && table.S > t)
        if (prevTable) {
          const tDiff = table.S - prevTable.S;
          const rDiff = table.R - prevTable.R;
          const tOffset = t - prevTable.S;
          const rOffset = (tOffset / tDiff) * rDiff;
          sDist = prevTable.R + rOffset;
        } else {
          sDist = table.R;
          sT = table.S;
        }


      if (pDist !== 0 && sDist !== 0) break;
      prevTable = table;
    }

    return { p_dist: pDist, s_dist: sDist, s_t: sT };
  }

  eewAreaPga(lat, lon, depth, mag) {
    const result = {};
    let eewMaxI = 0.0;

    for (const city of Object.keys(region))
      for (const town of Object.keys(region[city])) {
        const info = region[city][town];
        const distSurface = this.distance(lat, lon, info.lat, info.lon);
        const dist = Math.sqrt(Math.pow(distSurface, 2) + Math.pow(depth, 2));
        const pga = 1.657 * Math.exp(1.533 * mag) * Math.pow(dist, -1.607);
        let i = this.pgaToFloat(pga);

        if (i >= 4.5) i = this.eewAreaPgv([lat, lon], [info.lat, info.lon], depth, mag);

        if (i > eewMaxI) eewMaxI = i;

        result[info.code] = { dist, i };
      }

    result.max_i = eewMaxI;
    return result;
  }

  eewAreaPgv(epicenterLocation, pointLocation, depth, magW) {
    const long = Math.pow(10, 0.5 * magW - 1.85) / 2;
    const epicenterDistance = this.distance(
      epicenterLocation[0],
      epicenterLocation[1],
      pointLocation[0],
      pointLocation[1],
    );

    const hypocenterDistance = Math.sqrt(
      Math.pow(depth, 2) + Math.pow(epicenterDistance, 2),
    ) - long;

    const x = Math.max(hypocenterDistance, 3);

    const gpv600 = Math.pow(
      10,
      0.58 * magW +
                0.0038 * depth -
                1.29 -
                Math.log(x + 0.0028 * Math.pow(10, 0.5 * magW)) / this.ln10 -
                0.002 * x,
    );

    const pgv400 = gpv600 * 1.31;
    const pgv = pgv400 * 1.0;

    return 2.68 + 1.72 * Math.log(pgv) / this.ln10;
  }

  distance(latA, lngA, latB, lngB) {
    latA = latA * Math.PI / 180;
    lngA = lngA * Math.PI / 180;
    latB = latB * Math.PI / 180;
    lngB = lngB * Math.PI / 180;

    const sinLatA = Math.sin(Math.atan(Math.tan(latA)));
    const sinLatB = Math.sin(Math.atan(Math.tan(latB)));
    const cosLatA = Math.cos(Math.atan(Math.tan(latA)));
    const cosLatB = Math.cos(Math.atan(Math.tan(latB)));

    return Math.acos(
      sinLatA * sinLatB + cosLatA * cosLatB * Math.cos(lngA - lngB),
    ) * 6371.008;
  }

  sWaveTimeByDistance(depth, sDist) {
    let sTime = 0.0;
    const depthKey = this.findClosest(
      Object.keys(this.timeTable).map(Number),
      depth,
    ).toString();

    const timeTable = this.timeTable[depthKey];
    let prevTable = null;

    for (const table of timeTable) {
      if (sTime === 0 && table.R >= sDist)
        if (prevTable) {
          const rDiff = table.R - prevTable.R;
          const tDiff = table.S - prevTable.S;
          const rOffset = sDist - prevTable.R;
          const tOffset = (rOffset / rDiff) * tDiff;
          sTime = prevTable.S + tOffset;
        } else
          sTime = table.S;


      if (sTime !== 0) break;
      prevTable = table;
    }

    return sTime * 1000;
  }

  pWaveTimeByDistance(depth, pDist) {
    let pTime = 0.0;
    const depthKey = this.findClosest(
      Object.keys(this.timeTable).map(Number),
      depth,
    ).toString();

    const timeTable = this.timeTable[depthKey];
    let prevTable = null;

    for (const table of timeTable) {
      if (pTime === 0 && table.R >= pDist)
        if (prevTable) {
          const rDiff = table.R - prevTable.R;
          const tDiff = table.P - prevTable.P;
          const rOffset = pDist - prevTable.R;
          const tOffset = (rOffset / rDiff) * tDiff;
          pTime = prevTable.P + tOffset;
        } else
          pTime = table.P;


      if (pTime !== 0) break;
      prevTable = table;
    }

    return pTime * 1000;
  }

  calculateWaveTime(depth, distance) {
    const za = 1 * depth;
    let g0, G;
    const xb = distance;

    if (depth <= 40) {
      g0 = 5.10298;
      G = 0.06659;
    } else {
      g0 = 7.804799;
      G = 0.004573;
    }

    const zc = -1 * (g0 / G);
    const xc = (Math.pow(xb, 2) - 2 * (g0 / G) * za - Math.pow(za, 2)) / (2 * xb);
    let thetaA = Math.atan((za - zc) / xc);

    if (thetaA < 0)
      thetaA = thetaA + Math.PI;


    thetaA = Math.PI - thetaA;
    const thetaB = Math.atan(-1 * zc / (xb - xc));
    let ptime = (1 / G) * Math.log(Math.tan((thetaA / 2)) / Math.tan((thetaB / 2)));

    const g0_ = g0 / Math.sqrt(3);
    const g_ = G / Math.sqrt(3);
    const zc_ = -1 * (g0_ / g_);
    const xc_ = (Math.pow(xb, 2) - 2 * (g0_ / g_) * za - Math.pow(za, 2)) / (2 * xb);
    let thetaA_ = Math.atan((za - zc_) / xc_);

    if (thetaA_ < 0)
      thetaA_ = thetaA_ + Math.PI;


    thetaA_ = Math.PI - thetaA_;
    const thetaB_ = Math.atan(-1 * zc_ / (xb - xc_));
    let stime = (1 / g_) * Math.log(Math.tan(thetaA_ / 2) / Math.tan(thetaB_ / 2));

    if (distance / ptime > 7)
      ptime = distance / 7;

    if (distance / stime > 4)
      stime = distance / 4;


    return { p: ptime, s: stime };
  }

  // Utility functions
  findClosest(arr, target) {
    return arr.reduce((prev, curr) =>
      Math.abs(curr - target) < Math.abs(prev - target) ? curr : prev,
    );
  }

  pgaToFloat(pga) {
    return 2 * (Math.log(pga) / Math.log(10)) + 0.7;
  }

  pgaToIntensity(pga) {
    return this.intensityFloatToInt(this.pgaToFloat(pga));
  }

  intensityFloatToInt(floatValue) {
    if (floatValue < 0) return 0;
    if (floatValue < 4.5) return Math.round(floatValue);
    if (floatValue < 5) return 5;
    if (floatValue < 5.5) return 6;
    if (floatValue < 6) return 7;
    if (floatValue < 6.5) return 8;
    return 9;
  }

  intensityToNumberString(level) {
    switch (level) {
      case 5: return "5⁻";
      case 6: return "5⁺";
      case 7: return "6⁻";
      case 8: return "6⁺";
      case 9: return "7";
      default: return level.toString();
    }
  }
}

module.exports = EEWCalculator;