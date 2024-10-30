const TREM = require("../constant");

TREM.variable.events.on("DataRts", (data) => {
  console.log("事件觸發:", data);
});