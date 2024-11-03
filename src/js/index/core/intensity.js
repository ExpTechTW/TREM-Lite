const TREM = require("../constant");
const generateReportBoxItems = require("./report");

TREM.variable.events.on("IntensityRelease", (ans) => {
  generateReportBoxItems(TREM.variable.data.report, TREM.variable.data.intensity ? { time: TREM.variable.data.intensity.id, intensity: TREM.variable.data.intensity.max } : null);
});