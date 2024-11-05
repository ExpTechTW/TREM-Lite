const fetchData = require("../../core/utils/fetch");
const TREM = require("../constant");
const { extractLocation } = require("../utils/utils");
const crypto = require("crypto");
const { updateMapBounds } = require("./focus");
class ReportManager {
  static instance = null;

  constructor() {
    if (ReportManager.instance)
      return ReportManager.instance;
    this.closeButton = document.querySelector("#close-btn");
    this.reportWrapper = document.querySelector(".report-wrapper");
    this.reportBoxItems = document.querySelector(".report-box-items");
    this.customScrollbar = document.querySelector(".custom-scrollbar");
    this.isClose = false;
    this.isDragging = false;
    this.startY = 0;
    this.initialScrollTop = 0;
    this.bindEvents();
    ReportManager.instance = this;
  }

  static getInstance() {
    if (!ReportManager.instance)
      new ReportManager();
    return ReportManager.instance;
  }

  bindEvents() {
    this.closeButton.addEventListener("click", () => this.toggleReport());
    window.addEventListener("resize", () => this.initReportToggle());

    this.reportBoxItems.addEventListener("scroll", () => this.updateScrollbar());
    this.reportBoxItems.addEventListener("wheel", (e) => this.onScroll(e));
    this.customScrollbar.addEventListener("mousedown", (e) => this.onDragStart(e));
    document.addEventListener("mousemove", (e) => this.onDragMove(e));
    document.addEventListener("mouseup", () => this.onDragEnd());
    window.addEventListener("resize", () => this.updateScrollbar());

    TREM.variable.events.on("MapLoad", (map) => this.onMapLoad(map));
    TREM.variable.events.on("ReportRelease", (ans) => this.onReportRelease(ans));
  }

  onMapLoad(map) {
    this.initializeMapLayers(map);
    setInterval(() => this.refresh(), 10000);
    this.refresh();
  }

  initializeMapLayers(map) {
    map.addSource("report-markers-geojson", {
      type : "geojson",
      data : { type: "FeatureCollection", features: [] },
    });

    map.addLayer({
      id     : "report-markers",
      type   : "symbol",
      source : "report-markers-geojson",
      filter : ["!=", ["get", "i"], 0],
      layout : {
        "symbol-sort-key" : ["get", "i"],
        "symbol-z-order"  : "source",
        "icon-image"      : [
          "match",
          ["get", "i"],
          1, "intensity-1",
          2, "intensity-2",
          3, "intensity-3",
          4, "intensity-4",
          5, "intensity-5",
          6, "intensity-6",
          7, "intensity-7",
          8, "intensity-8",
          9, "intensity-9",
          "cross",
        ],
        "icon-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          5, 0.2,
          10, 0.6,
        ],
        "icon-allow-overlap"    : true,
        "icon-ignore-placement" : true,
      },
    });

    map.addLayer({
      id     : "report-markers-cross",
      type   : "symbol",
      source : "report-markers-geojson",
      filter : ["==", ["get", "i"], 0],
      layout : {
        "symbol-sort-key" : ["get", "i"],
        "symbol-z-order"  : "source",
        "icon-image"      : "cross",
        "icon-size"       : [
          "interpolate",
          ["linear"],
          ["zoom"],
          5, 0.01,
          10, 0.09,
        ],
        "icon-allow-overlap"    : true,
        "icon-ignore-placement" : true,
      },
    });
  }

  toggleReport() {
    this.closeButton.classList.toggle("off");
    this.reportWrapper.classList.toggle("hidden");
    this.isClose = !this.isClose;
  }

  initReportToggle() {
    if (!this.isClose && window.innerWidth < 1080)
      this.toggleReport();

  }

  updateScrollbar() {
    const { scrollHeight, clientHeight, scrollTop } = this.reportBoxItems;
    const maxScrollbarTop = clientHeight - this.customScrollbar.clientHeight;
    this.customScrollbar.style.height = `${Math.max((clientHeight / scrollHeight) * clientHeight, 30)}px`;
    this.customScrollbar.style.top = `${(scrollTop / (scrollHeight - clientHeight)) * maxScrollbarTop}px`;
  }

  onScroll(event) {
    this.reportBoxItems.scrollTop += event.deltaY;
    this.updateScrollbar();
  }

  onDragStart(e) {
    this.isDragging = true;
    this.startY = e.clientY;
    this.initialScrollTop = this.reportBoxItems.scrollTop;
    document.body.style.userSelect = "none";
  }

  onDragMove(e) {
    if (!this.isDragging) return;
    const deltaY = e.clientY - this.startY;
    const scrollRatio = deltaY / (this.reportBoxItems.clientHeight - this.customScrollbar.clientHeight);
    this.reportBoxItems.scrollTop = this.initialScrollTop + scrollRatio * (this.reportBoxItems.scrollHeight - this.reportBoxItems.clientHeight);
  }

  onDragEnd() {
    this.isDragging = false;
    document.body.style.userSelect = "";
  }

  formatTime(timestamp) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  createIntensityBox(intensity = "0") {
    const box = document.createElement("div");
    box.className = "report-intensity-box";

    const val = document.createElement("div");
    val.className = `report-intensity-val intensity-${intensity}`;

    const text = document.createElement("div");
    text.className = "report-intensity-text";

    box.appendChild(val);
    box.appendChild(text);
    return box;
  }

  createInfoBox(item, isSurvey = false) {
    const box = document.createElement("div");
    box.className = "report-info-box";

    const infoItem = document.createElement("div");
    infoItem.className = "report-info-item";

    const loc = document.createElement("div");
    loc.className = "report-loc";
    if (!isSurvey && item.loc)
      loc.textContent = extractLocation(item.loc);


    const time = document.createElement("div");
    time.className = "report-time";
    time.textContent = this.formatTime(item.time);

    infoItem.appendChild(loc);
    infoItem.appendChild(time);

    const magDep = document.createElement("div");
    magDep.className = "report-mag-dep";

    const mag = document.createElement("div");
    mag.className = "report-mag";
    const magText = document.createElement("div");
    magText.className = "report-mag-text";
    const magVal = document.createElement("div");
    magVal.className = "report-mag-val";
    magVal.textContent = item.mag ? item.mag.toFixed(1) : "";
    mag.appendChild(magText);
    mag.appendChild(magVal);

    const depth = document.createElement("div");
    depth.className = "report-depth";
    const depthText = document.createElement("div");
    depthText.className = "report-depth-text";
    const depthVal = document.createElement("div");
    depthVal.className = "report-depth-val";
    depthVal.textContent = item.depth || "";
    depth.appendChild(depthText);
    depth.appendChild(depthVal);

    magDep.appendChild(mag);
    magDep.appendChild(depth);
    box.appendChild(infoItem);
    box.appendChild(magDep);

    return box;
  }

  createReportItem(item, isSurvey = false) {
    const container = document.createElement("div");
    container.className = `report-box-item-contain${isSurvey ? " survey" : ""}`;
    container.appendChild(this.createIntensityBox(item.int));
    container.appendChild(this.createInfoBox(item, isSurvey));
    return container;
  }

  generateReportBoxItems(list, survey = null) {
    const container = document.getElementById("report-box-items");
    if (!container) return;

    container.innerHTML = "";

    if (survey) {
      const surveyItem = {
        int   : survey.intensity || 0,
        loc   : "",
        time  : survey.time,
        mag   : "",
        depth : "",
      };
      container.appendChild(this.createReportItem(surveyItem, true));
    }

    list.forEach(item => {
      container.appendChild(this.createReportItem(item, false));
    });
  }

  async getReport() {
    const url = TREM.constant.URL.API[Math.floor(Math.random() * TREM.constant.URL.API.length)];
    const ans = await fetchData(
      `https://${url}/api/v2/eq/report?limit=${TREM.constant.REPORT_LIMIT}`,
      TREM.constant.HTTP_TIMEOUT.REPORT,
    );
    if (!ans || !ans.ok) return null;
    return await ans.json();
  }

  async getReportInfo(id) {
    const url = TREM.constant.URL.API[Math.floor(Math.random() * TREM.constant.URL.API.length)];
    const ans = await fetchData(
      `https://${url}/api/v2/eq/report/${id}`,
      TREM.constant.HTTP_TIMEOUT.REPORT,
    );
    if (!ans || !ans.ok) return null;
    return await ans.json();
  }

  async refresh() {
    const reportList = await this.getReport();
    if (!reportList) return;

    if (!TREM.variable.data.report.length) {
      TREM.variable.data.report = reportList;
      if (TREM.constant.SHOW_REPORT) {
        const data = await this.getReportInfo(reportList[0].id);
        TREM.variable.cache.last_report = data;
      }
      this.generateReportBoxItems(
        TREM.variable.data.report,
        TREM.variable.cache.intensity.time
          ? {
            time      : TREM.variable.cache.intensity.time,
            intensity : TREM.variable.cache.intensity.max,
          }
          : null,
      );
      return;
    }

    const existingIds = new Set(TREM.variable.data.report.map(item => item.id));
    const newReports = reportList.filter(report => !existingIds.has(report.id));

    if (newReports.length > 0) {
      const data = await this.getReportInfo(newReports[0].id);
      if (data)
        TREM.variable.events.emit("ReportRelease", { data });
    }
  }

  simplifyEarthquakeData(data) {
    let maxIntensity = 0;
    Object.values(data.list).forEach(county => {
      if (county.int > maxIntensity)
        maxIntensity = county.int;

    });

    const earthquakeData = {
      id      : data.id,
      lat     : data.lat,
      lon     : data.lon,
      depth   : data.depth,
      loc     : data.loc,
      mag     : data.mag,
      time    : data.time,
      int     : maxIntensity,
      eq_list : data.list,
      trem    : data.trem,
    };

    const md5Value = crypto
      .createHash("md5")
      .update(JSON.stringify(earthquakeData))
      .digest("hex")
      .toUpperCase();

    return {
      ...earthquakeData,
      md5: md5Value,
    };
  }

  showReportPoint(data) {
    if (!data) return;

    const dataList = [];

    for (const city of Object.keys(data.list))
      for (const town of Object.keys(data.list[city].town)) {
        const info = data.list[city].town[town];
        TREM.variable.cache.bounds.report.push({ lon: info.lon, lat: info.lat });
        dataList.push({
          type       : "Feature",
          geometry   : { type: "Point", coordinates: [info.lon, info.lat] },
          properties : { i: info.int },
        });
      }


    dataList.push({
      type       : "Feature",
      geometry   : { type: "Point", coordinates: [data.lon, data.lat] },
      properties : { i: 0 },
    });

    updateMapBounds(TREM.variable.cache.bounds.report);
    TREM.variable.map.getSource("report-markers-geojson").setData({
      type     : "FeatureCollection",
      features : dataList,
    });
  }

  onReportRelease(ans) {
    if (TREM.constant.SHOW_REPORT)
      this.showReportPoint(ans.data);

    const data = this.simplifyEarthquakeData(ans.data);
    TREM.variable.data.report.unshift(data);
    this.generateReportBoxItems(
      TREM.variable.data.report,
      TREM.variable.cache.intensity.time
        ? {
          time      : TREM.variable.cache.intensity.time,
          intensity : TREM.variable.cache.intensity.max,
        }
        : null,
    );
  }
}

TREM.class.ReportManager = ReportManager;

const reportManager = ReportManager.getInstance();

if (window.innerWidth < 1080)
  reportManager.toggleReport();

reportManager.updateScrollbar();

module.exports = {
  generateReportBoxItems : (list, survey) => reportManager.generateReportBoxItems(list, survey),
  show_report_point      : (data) => reportManager.showReportPoint(data),
};