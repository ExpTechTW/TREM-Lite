const TREM = require("../constant");
const box_data = require("../../../resource/data/box.json");
const { distance } = require("../utils/utils");

let box_alert = false;

class BoxManager {
  static instance = null;

  constructor() {
    if (BoxManager.instance)
      return BoxManager.instance;
    this.bindEvents();
    BoxManager.instance = this;
  }

  static getInstance() {
    if (!BoxManager.instance)
      new BoxManager();
    return BoxManager.instance;
  }

  bindEvents() {
    TREM.variable.events.on("MapLoad", (map) => {
      map.addSource("box-geojson", {
        type : "geojson",
        data : {
          type     : "FeatureCollection",
          features : [],
        },
      });

      map.addLayer({
        id     : "box-geojson",
        type   : "line",
        source : "box-geojson",
        paint  : {
          "line-width" : 2,
          "line-color" : [
            "match",
            ["get", "i"],
            9, TREM.constant.COLOR.BOX[2],
            8, TREM.constant.COLOR.BOX[2],
            7, TREM.constant.COLOR.BOX[2],
            6, TREM.constant.COLOR.BOX[2],
            5, TREM.constant.COLOR.BOX[2],
            4, TREM.constant.COLOR.BOX[2],
            3, TREM.constant.COLOR.BOX[1],
            2, TREM.constant.COLOR.BOX[1],
            1, TREM.constant.COLOR.BOX[0],
            TREM.constant.COLOR.BOX[0],
          ],
        },
      });
    });
  }

  checkBoxSkip(eew, area) {
    let skip = 0;
    const coordinates = area.geometry.coordinates[0];
    for (let i = 0; i < 4; i++) {
      const dist = distance(eew.eq.lat, eew.eq.lon)(coordinates[i][1], coordinates[i][0]);
      if (eew.dist.s_dist > dist) skip++;
    }
    return skip >= 4;
  }

  refreshBox(show) {
    const boxFeatures = [];
    const emptyData = {
      type     : "FeatureCollection",
      features : boxFeatures,
    };

    if (box_alert) {
      box_alert = false;
      TREM.variable.map.getSource("box-geojson").setData(emptyData);
    }

    if (!TREM.variable.data.rts?.box || !Object.keys(TREM.variable.data.rts.box).length) return;

    const trem_alert = TREM.variable.data.eew.some(eew => eew.author == "trem");
    if (!TREM.constant.SHOW_TREM_EEW && trem_alert) {
      TREM.variable.map.getSource("box-geojson").setData(emptyData);
      return;
    }

    if (show && TREM.variable.data.rts)
      for (const area of box_data.features) {
        const id = area.properties.ID;
        const boxIntensity = TREM.variable.data.rts?.box[id];
        if (boxIntensity == undefined) continue;

        let shouldSkip = false;
        for (const eew of TREM.variable.data.eew) {
          if (!eew.dist) continue;
          if (this.checkBoxSkip(eew, area)) {
            shouldSkip = true;
            break;
          }
        }
        if (shouldSkip) continue;

        boxFeatures.push({
          type     : "Feature",
          geometry : {
            type        : "Polygon",
            coordinates : [area.geometry.coordinates[0]],
          },
          properties: {
            i: boxIntensity,
          },
        });
      }

    box_alert = true;
    TREM.variable.map.getSource("box-geojson").setData({
      type     : "FeatureCollection",
      features : boxFeatures,
    });
  }
}

TREM.class.BoxManager = BoxManager;

const boxManager = BoxManager.getInstance();
module.exports = (...args) => boxManager.refreshBox(...args);