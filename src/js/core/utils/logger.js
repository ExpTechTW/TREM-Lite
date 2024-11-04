const winston = require("winston");
const path = require("path");
const { app } = require("@electron/remote");
require("winston-daily-rotate-file");

class Logger {
  constructor() {
    if (Logger.instance)
      return Logger.instance;

    this.logger = this.initLogger();
    Logger.instance = this;
  }

  initLogger() {
    const logPath = path.join(app.getPath("logs"), "%DATE%.log");

    const file = new winston.transports.DailyRotateFile({
      filename      : logPath,
      datePattern   : "YYYY-MM-DD",
      zippedArchive : true,
      maxSize       : "20m",
      maxFiles      : "14d",
    });

    return winston.createLogger({
      level  : "info",
      format : winston.format.printf(info => {
        const date = new Date();
        return `[${this.formatTwoDigits(date.getHours())}:${this.formatTwoDigits(date.getMinutes())}:${this.formatTwoDigits(date.getSeconds())}][${info.level.toUpperCase()}]: ${info.message}`;
      }),
      transports: [
        new winston.transports.Console(),
        file,
      ],
    });
  }

  formatTwoDigits(n) {
    return n < 10 ? "0" + n : n;
  }

  info(message) {
    this.logger.info(message);
  }

  error(message) {
    this.logger.error(message);
  }

  warn(message) {
    this.logger.warn(message);
  }

  debug(message) {
    this.logger.debug(message);
  }
}

const loggerInstance = new Logger();
Object.freeze(loggerInstance);

module.exports = loggerInstance;