// const TREM = require("../index/constant");
// const MixinManager = require("../core/mixin");

// const loggingMixin = (original, ...args) => {
//   console.log("Refreshing reports...");
//   const result = original(...args);
//   console.log("Reports refreshed");
//   return result;
// };

// MixinManager.inject(TREM.class.ReportManager, "refresh", loggingMixin, 0);