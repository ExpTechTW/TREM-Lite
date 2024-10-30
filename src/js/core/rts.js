const TREM = require("../constant");

TREM.variable.map.addSource("points", {
  type : "geojson",
  data : {
    type     : "FeatureCollection",
    features : [
      {
        type     : "Feature",
        geometry : {
          type        : "Point",
          coordinates : [121.5, 25.0], // [經度, 緯度]
        },
        properties: {
          intensity : 3, // 可以根據這個值來決定顏色
          title     : "點位1",
        },
      },
      // 更多點位...
    ],
  },
});

// // 添加圖層並設置顏色
// TREM.variable.map.addLayer({
//   id     : "points-layer",
//   type   : "circle",
//   source : "points",
//   paint  : {
//     // 使用 match expression 根據 intensity 設置顏色
//     "circle-color": [
//       "match",
//       ["get", "intensity"],
//       0, "#FFFFFF",
//       1, "#A8F1FF",
//       2, "#A8FFB3",
//       3, "#FCFF96",
//       4, "#FFD17D",
//       5, "#FF997D",
//       6, "#FF7D7D",
//       7, "#FF5959",
//       8, "#FF3535",
//       9, "#FF0000",
//       "#000000", // 默認顏色
//     ],
//     "circle-radius"  : 8,
//     "circle-opacity" : 0.8,
//   },
// });

// // 如果需要動態更新數據
// TREM.variable.map.getSource("points").setData({
//   type     : "FeatureCollection",
//   features : [
//     // 新的點位數據...
//   ],
// });

TREM.variable.events.on("DataRts", (data) => {
  console.log("事件觸發:", data);
});