const close_button = document.querySelector("#close-btn");
const reportWrapper = document.querySelector(".report-wrapper");

close_button.addEventListener("click", () => {
  close_button.classList.toggle("off");
  reportWrapper.classList.toggle("hidden");
});

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

function extractLocation(loc) {
  const match = loc.match(/位於(.+)(?=\))/);
  return match ? match[1] : loc;
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

const sampleData = [
  {
    "id"    : "113485-2024-1027-145655",
    "lat"   : 23.42,
    "lon"   : 120.5,
    "depth" : 5,
    "loc"   : "嘉義縣政府東方  21.3  公里 (位於嘉義縣中埔鄉)",
    "mag"   : 4.9,
    "time"  : 1730012215000,
    "int"   : 4,
    "trem"  : 1730012216818,
    "md5"   : "12260EEADCC5188D413B1A77EC204C6E",
  },
  {
    "id"    : "113484-2024-1027-142845",
    "lat"   : 23.42,
    "lon"   : 120.48,
    "depth" : 5.8,
    "loc"   : "嘉義縣政府東南東方  19.3  公里 (位於嘉義縣中埔鄉)",
    "mag"   : 4.5,
    "time"  : 1730010525000,
    "int"   : 4,
    "trem"  : 1730010528356,
    "md5"   : "A00BAB0CFDD53CADC393FB505851AD4B",
  },
  {
    "id"    : "113000-2024-1027-142116",
    "lat"   : 23.41,
    "lon"   : 120.48,
    "depth" : 8.7,
    "loc"   : "嘉義縣政府東南東方  19.8  公里 (位於嘉義縣中埔鄉)",
    "mag"   : 3.3,
    "time"  : 1730010076000,
    "int"   : 2,
    "trem"  : 0,
    "md5"   : "10833139392BD45A068389AF7CC97488",
  },
  {
    "id"    : "113483-2024-1027-141912",
    "lat"   : 23.42,
    "lon"   : 120.48,
    "depth" : 5.6,
    "loc"   : "嘉義縣政府東南東方  19.7  公里 (位於嘉義縣中埔鄉)",
    "mag"   : 4.8,
    "time"  : 1730009952000,
    "int"   : 4,
    "trem"  : 1730009954366,
    "md5"   : "4DBE67CE57C433FFCEC47A2873C69DE6",
  },
  {
    "id"    : "113000-2024-1026-015855",
    "lat"   : 23.42,
    "lon"   : 120.48,
    "depth" : 5.6,
    "loc"   : "嘉義縣政府東南東方  19.6  公里 (位於嘉義縣中埔鄉)",
    "mag"   : 3.1,
    "time"  : 1729879135000,
    "int"   : 2,
    "trem"  : 1729879139568,
    "md5"   : "F9FC0F70F940B934D4125921ECB8F363",
  },
  {
    "id"    : "113482-2024-1024-235932",
    "lat"   : 24.23,
    "lon"   : 122.38,
    "depth" : 67.2,
    "loc"   : "花蓮縣政府東北東方  82.1  公里 (位於臺灣東部海域)",
    "mag"   : 4.9,
    "time"  : 1729785572000,
    "int"   : 3,
    "trem"  : 1729785589701,
    "md5"   : "A72D6D1643DF5FEF3B49488C9AC4DEAC",
  },
  {
    "id"    : "113000-2024-1023-085014",
    "lat"   : 23.73,
    "lon"   : 121.39,
    "depth" : 20.5,
    "loc"   : "花蓮縣政府西南方  36.7  公里 (位於花蓮縣萬榮鄉)",
    "mag"   : 3.4,
    "time"  : 1729644614000,
    "int"   : 2,
    "trem"  : 1729644619439,
    "md5"   : "D598477242F265A87875B824E969F012",
  },
  {
    "id"    : "113000-2024-1022-151544",
    "lat"   : 24.02,
    "lon"   : 121.51,
    "depth" : 16.3,
    "loc"   : "花蓮縣政府西北西方  12.0  公里 (位於花蓮縣秀林鄉)",
    "mag"   : 3.8,
    "time"  : 1729581344000,
    "int"   : 3,
    "trem"  : 1729581348940,
    "md5"   : "0E9C1833636403A1EA8BDA5FCFD19467",
  },
  {
    "id"    : "113000-2024-1022-133206",
    "lat"   : 23.5,
    "lon"   : 121.26,
    "depth" : 9,
    "loc"   : "花蓮縣政府西南方  66.1  公里 (位於花蓮縣卓溪鄉)",
    "mag"   : 4.1,
    "time"  : 1729575126000,
    "int"   : 3,
    "trem"  : 1729575129995,
    "md5"   : "85D95E4FE5321F3755469673E95D1CC9",
  },
  {
    "id"    : "113000-2024-1021-091758",
    "lat"   : 24.73,
    "lon"   : 120.04,
    "depth" : 22.5,
    "loc"   : "苗栗縣政府西北西方  80.9  公里 (位於臺灣西部海域)",
    "mag"   : 4.3,
    "time"  : 1729473478000,
    "int"   : 2,
    "trem"  : 0,
    "md5"   : "5657FD01C7EE33CABDD03968A96BAB39",
  },
  {
    "id"    : "113000-2024-1020-125439",
    "lat"   : 23.99,
    "lon"   : 120.61,
    "depth" : 28.5,
    "loc"   : "彰化縣政府東南方  11.5  公里 (位於彰化縣芬園鄉)",
    "mag"   : 3.1,
    "time"  : 1729400079000,
    "int"   : 2,
    "trem"  : 0,
    "md5"   : "E6A899193702FA58688C31B2A8797A5E",
  },
  {
    "id"    : "113000-2024-1020-072006",
    "lat"   : 23.9,
    "lon"   : 121.47,
    "depth" : 18.8,
    "loc"   : "花蓮縣政府西南西方  18.7  公里 (位於花蓮縣秀林鄉)",
    "mag"   : 3.1,
    "time"  : 1729380006000,
    "int"   : 3,
    "trem"  : 1729380011142,
    "md5"   : "81A5AC3091CFC00BF001883DF1BF161C",
  },
  {
    "id"    : "113000-2024-1019-012119",
    "lat"   : 23.92,
    "lon"   : 121.47,
    "depth" : 18,
    "loc"   : "花蓮縣政府西南西方  17.7  公里 (位於花蓮縣秀林鄉)",
    "mag"   : 3.5,
    "time"  : 1729272079000,
    "int"   : 3,
    "trem"  : 1729272083195,
    "md5"   : "36A95B6362E0EB0647EA44907877CF7B",
  },
  {
    "id"    : "113000-2024-1018-133159",
    "lat"   : 23.92,
    "lon"   : 121.63,
    "depth" : 34.8,
    "loc"   : "花蓮縣政府南方  8.5  公里 (位於花蓮縣近海)",
    "mag"   : 4,
    "time"  : 1729229519000,
    "int"   : 1,
    "trem"  : 1729229526956,
    "md5"   : "01C0246A29EB11316C9F8F430DF2E770",
  },
  {
    "id"    : "113000-2024-1018-075249",
    "lat"   : 23.64,
    "lon"   : 121.44,
    "depth" : 15,
    "loc"   : "花蓮縣政府南南西方  42.8  公里 (位於花蓮縣光復鄉)",
    "mag"   : 3.6,
    "time"  : 1729209169000,
    "int"   : 3,
    "trem"  : 1729209172960,
    "md5"   : "D2C31A04E325593E35DCFB69E9BF0F65",
  },
  {
    "id"    : "113000-2024-1016-223759",
    "lat"   : 24.41,
    "lon"   : 121.84,
    "depth" : 12.8,
    "loc"   : "宜蘭縣政府南南東方  35.9  公里 (位於宜蘭縣近海)",
    "mag"   : 3.1,
    "time"  : 1729089479000,
    "int"   : 3,
    "trem"  : 1729089487420,
    "md5"   : "1A7F009083C3EF39B115AEF3FD84AB9F",
  },
  {
    "id"    : "113481-2024-1016-215821",
    "lat"   : 24.02,
    "lon"   : 121.7,
    "depth" : 25.2,
    "loc"   : "花蓮縣政府東北東方  8.9  公里 (位於花蓮縣近海)",
    "mag"   : 5.2,
    "time"  : 1729087101000,
    "int"   : 3,
    "trem"  : 1729087109436,
    "md5"   : "EE0072103FFD91ABD58828DAB20FE30E",
  },
  {
    "id"    : "113480-2024-1014-211716",
    "lat"   : 24.2,
    "lon"   : 121.84,
    "depth" : 20.5,
    "loc"   : "花蓮縣政府東北方  31.8  公里 (位於臺灣東部海域)",
    "mag"   : 5,
    "time"  : 1728911836000,
    "int"   : 4,
    "trem"  : 1728911846537,
    "md5"   : "CA5A091A468DE55877AED247E6054AB2",
  },
  {
    "id"    : "113479-2024-1014-192015",
    "lat"   : 24.2,
    "lon"   : 121.67,
    "depth" : 29.8,
    "loc"   : "花蓮縣政府北北東方  23.5  公里 (位於花蓮縣近海)",
    "mag"   : 4.4,
    "time"  : 1728904815000,
    "int"   : 3,
    "trem"  : 1728904824302,
    "md5"   : "2CF784D1444E4C62AA1A323EA9BCADA7",
  },
  {
    "id"    : "113000-2024-1013-233509",
    "lat"   : 23.33,
    "lon"   : 120.16,
    "depth" : 8.7,
    "loc"   : "嘉義縣政府西南方  19.9  公里 (位於嘉義縣布袋鎮)",
    "mag"   : 3.6,
    "time"  : 1728833709000,
    "int"   : 3,
    "trem"  : 1728833737929,
    "md5"   : "DD926678FDA35863D1C8F7C54EDDB3BE",
  },
  {
    "id"    : "113478-2024-1013-193632",
    "lat"   : 24.03,
    "lon"   : 121.52,
    "depth" : 18.7,
    "loc"   : "花蓮縣政府西北西方  11.1  公里 (位於花蓮縣秀林鄉)",
    "mag"   : 4.9,
    "time"  : 1728819392000,
    "int"   : 4,
    "trem"  : 1728819396566,
    "md5"   : "02376F36200214689A6D037E20EE1ABB",
  },
  {
    "id"    : "113000-2024-1012-122436",
    "lat"   : 23.83,
    "lon"   : 121.71,
    "depth" : 21.5,
    "loc"   : "花蓮縣政府南南東方  20.3  公里 (位於臺灣東部海域)",
    "mag"   : 4,
    "time"  : 1728707076000,
    "int"   : 2,
    "trem"  : 1728707081961,
    "md5"   : "3ABA217C403702287696C622545C5A7F",
  },
  {
    "id"    : "113000-2024-1012-030633",
    "lat"   : 23.7,
    "lon"   : 121.42,
    "depth" : 12.5,
    "loc"   : "花蓮縣政府西南方  37.9  公里 (位於花蓮縣鳳林鎮)",
    "mag"   : 3.3,
    "time"  : 1728673593000,
    "int"   : 3,
    "trem"  : 1728673596924,
    "md5"   : "F9E5F93BEC0C2A15AA5ED762342EC692",
  },
  {
    "id"    : "113477-2024-1011-205208",
    "lat"   : 23.71,
    "lon"   : 121.49,
    "depth" : 10.5,
    "loc"   : "花蓮縣政府南南西方  34.0  公里 (位於花蓮縣光復鄉)",
    "mag"   : 4.8,
    "time"  : 1728651128000,
    "int"   : 4,
    "trem"  : 1728651132346,
    "md5"   : "BCEB84806D713A83ADFCC4C8840B5F6D",
  },
  {
    "id"    : "113000-2024-1011-142256",
    "lat"   : 24.19,
    "lon"   : 121.23,
    "depth" : 6.1,
    "loc"   : "南投縣政府東北東方  63.3  公里 (位於南投縣仁愛鄉)",
    "mag"   : 3.7,
    "time"  : 1728627776000,
    "int"   : 4,
    "trem"  : 1728627793287,
    "md5"   : "57297E28F0EDD00DB111A79CF55C959D",
  },
  {
    "id"    : "113476-2024-1010-204050",
    "lat"   : 23.81,
    "lon"   : 121.49,
    "depth" : 14.4,
    "loc"   : "花蓮縣政府西南方  24.1  公里 (位於花蓮縣壽豐鄉)",
    "mag"   : 4.6,
    "time"  : 1728564050000,
    "int"   : 4,
    "trem"  : 1728564055389,
    "md5"   : "DA83DF96F6BF562EB34CBDD32F4DC2FF",
  },
  {
    "id"    : "113475-2024-1009-001419",
    "lat"   : 24.05,
    "lon"   : 121.66,
    "depth" : 29,
    "loc"   : "花蓮縣政府東北方  8.0  公里 (位於花蓮縣近海)",
    "mag"   : 4.5,
    "time"  : 1728404059000,
    "int"   : 3,
    "trem"  : 1728404067032,
    "md5"   : "CB15BF2E36DEDEC73D63FADCAE5B00FE",
  },
  {
    "id"    : "113000-2024-1007-181650",
    "lat"   : 23.03,
    "lon"   : 121.72,
    "depth" : 23.1,
    "loc"   : "臺東縣政府東北東方  66.2  公里 (位於臺灣東部海域)",
    "mag"   : 3.7,
    "time"  : 1728296210000,
    "int"   : 2,
    "trem"  : 0,
    "md5"   : "6B138AC1CB8C7B16676987708997FD5F",
  },
  {
    "id"    : "113000-2024-1007-070027",
    "lat"   : 24.12,
    "lon"   : 121.76,
    "depth" : 28,
    "loc"   : "花蓮縣政府東北方  20.6  公里 (位於臺灣東部海域)",
    "mag"   : 3.4,
    "time"  : 1728255627000,
    "int"   : 2,
    "trem"  : 1728255637264,
    "md5"   : "0B6C9B8D2D72E18FC799DCB1853957EA",
  },
];

generateReportBoxItems(sampleData, {
  time      : 1730012315000,
  intensity : 9,
});