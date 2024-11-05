const winston = require("winston");
const path = require("path");
const { app } = require("@electron/remote");
require("winston-daily-rotate-file");
const colors = require("colors/safe");

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

    const levelColors = {
      error : colors.red,
      warn  : colors.yellow,
      info  : colors.green,
      debug : colors.blue,
    };

    const consoleFormat = winston.format.printf(info => {
      const date = new Date();
      const timestamp = `${this.formatTwoDigits(date.getHours())}:${this.formatTwoDigits(date.getMinutes())}:${this.formatTwoDigits(date.getSeconds())}`;
      const level = info.level.toUpperCase();
      const coloredLevel = levelColors[info.level](level);
      return `[${colors.grey(timestamp)}][${coloredLevel}]: ${info.message}`;
    });

    const fileFormat = winston.format.printf(info => {
      const date = new Date();
      const timestamp = `${this.formatTwoDigits(date.getHours())}:${this.formatTwoDigits(date.getMinutes())}:${this.formatTwoDigits(date.getSeconds())}`;
      return `[${timestamp}][${info.level.toUpperCase()}]: ${info.message}`;
    });

    return winston.createLogger({
      level      : "info",
      transports : [
        new winston.transports.Console({
          format: consoleFormat,
        }),
        new winston.transports.DailyRotateFile({
          ...file,
          format: fileFormat,
        }),
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