const fetchData = require("../../core/utils/fetch");
const TREM = require("../constant");
const { extractLocation } = require("../utils/utils");

const crypto = require("crypto");

const close_button = document.querySelector("#close-btn");
const reportWrapper = document.querySelector(".report-wrapper");

let close = false;

close_button.addEventListener("click", toggleReport);

function toggleReport() {
  close_button.classList.toggle("off");
  reportWrapper.classList.toggle("hidden");
  close = !close;
}

function initReportToggle() {
  if (!close && window.innerWidth < 1080) toggleReport();
}

window.addEventListener("resize", initReportToggle);
if (window.innerWidth < 1080) toggleReport();

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function createIntensityBox(intensity = "0") {
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

function createInfoBox(item, isSurvey = false) {
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
  time.textContent = formatTime(item.time);

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

function createReportItem(item, isSurvey = false) {
  const container = document.createElement("div");
  container.className = `report-box-item-contain${isSurvey ? " survey" : ""}`;

  container.appendChild(createIntensityBox(item.int));
  container.appendChild(createInfoBox(item, isSurvey));

  return container;
}

function generateReportBoxItems(list, survey = null) {
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
    container.appendChild(createReportItem(surveyItem, true));
  }

  list.forEach(item => {
    container.appendChild(createReportItem(item, false));
  });
}

async function get_report() {
  const url = TREM.constant.URL.API[Math.floor(Math.random() * TREM.constant.URL.API.length)];
  const ans = await fetchData(`https://${url}/api/v2/eq/report?limit=${TREM.constant.REPORT_LIMIT}`, TREM.constant.HTTP_TIMEOUT.REPORT);
  if (!ans.ok) return null;
  return await ans.json();
}

async function get_report_info(id) {
  const url = TREM.constant.URL.API[Math.floor(Math.random() * TREM.constant.URL.API.length)];
  const ans = await fetchData(`https://${url}/api/v2/eq/report/${id}`, TREM.constant.HTTP_TIMEOUT.REPORT);
  if (!ans.ok) return null;
  return await ans.json();
}

async function refresh_report() {
  const report_list = await get_report();
  if (!report_list) return;

  if (!TREM.variable.data.report.length) {
    TREM.variable.data.report = report_list;
    generateReportBoxItems(TREM.variable.data.report, TREM.variable.cache.intensity.time ? { time: TREM.variable.cache.intensity.time, intensity: TREM.variable.cache.intensity.max } : null);
    return;
  }

  const existingIds = new Set(TREM.variable.data.report.map(item => item.id));
  const newReports = report_list.filter(report => !existingIds.has(report.id));

  if (newReports.length > 0) {
    const data = await get_report_info(newReports[0].id);
    if (data) TREM.variable.events.emit("ReportRelease", { data });
  }
}

function simplifyEarthquakeData(data) {
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

  const md5Value = crypto.createHash("md5")
    .update(JSON.stringify(earthquakeData))
    .digest("hex")
    .toUpperCase();

  return {
    ...earthquakeData,
    md5: md5Value,
  };
}

TREM.variable.events.on("ReportRelease", (ans) => {
  const data = simplifyEarthquakeData(ans.data);
  TREM.variable.data.report.unshift(data);
  generateReportBoxItems(TREM.variable.data.report, TREM.variable.cache.intensity.time ? { time: TREM.variable.cache.intensity.time, intensity: TREM.variable.cache.intensity.max } : null);
});

TREM.variable.events.on("MapLoad", (map) => {
  setInterval(refresh_report, 10000);
  refresh_report();
});

module.exports = generateReportBoxItems;

/** 滾動條 **/
const reportBoxItems = document.querySelector(".report-box-items");
const customScrollbar = document.querySelector(".custom-scrollbar");

let isDragging = false, startY, initialScrollTop;

const updateScrollbar = () => {
  const { scrollHeight, clientHeight, scrollTop } = reportBoxItems;
  const maxScrollbarTop = clientHeight - customScrollbar.clientHeight;
  customScrollbar.style.height = `${Math.max((clientHeight / scrollHeight) * clientHeight, 30)}px`;
  customScrollbar.style.top = `${(scrollTop / (scrollHeight - clientHeight)) * maxScrollbarTop}px`;
};

const onScroll = () => {
  reportBoxItems.scrollTop += event.deltaY;
  updateScrollbar();
};

const onDragStart = (e) => {
  isDragging = true;
  startY = e.clientY;
  initialScrollTop = reportBoxItems.scrollTop;
  document.body.style.userSelect = "none";
};

const onDragMove = (e) => {
  if (!isDragging) return;
  const deltaY = e.clientY - startY;
  const scrollRatio = deltaY / (reportBoxItems.clientHeight - customScrollbar.clientHeight);
  reportBoxItems.scrollTop = initialScrollTop + scrollRatio * (reportBoxItems.scrollHeight - reportBoxItems.clientHeight);
};

const onDragEnd = () => {
  isDragging = false;
  document.body.style.userSelect = "";
};

reportBoxItems.addEventListener("scroll", updateScrollbar);
reportBoxItems.addEventListener("wheel", onScroll);
customScrollbar.addEventListener("mousedown", onDragStart);
document.addEventListener("mousemove", onDragMove);
document.addEventListener("mouseup", onDragEnd);
window.addEventListener("resize", updateScrollbar);
updateScrollbar();