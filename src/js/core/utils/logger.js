const winston = require('winston');
const path = require('path');
const { app } = require('@electron/remote');
require('winston-daily-rotate-file');
const colors = require('colors/safe');
const util = require('util');

class Logger {
  static #instance;
  static #privateStore = new WeakMap();

  constructor() {
    if (Logger.#instance && this.constructor === Logger) {
      return Logger.#instance;
    }

    const privateData = {
      logger: this.#initLogger(),
    };
    Logger.#privateStore.set(this, privateData);

    if (this.constructor === Logger) {
      Logger.#instance = this;
    }
  }

  #initLogger() {
    const logPath = path.join(app.getPath('logs'), '%DATE%.log');

    const file = new winston.transports.DailyRotateFile({
      filename: logPath,
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
    });

    const levelColors = {
      error: colors.red,
      warn: colors.yellow,
      info: colors.green,
      debug: colors.blue,
    };

    const consoleFormat = winston.format.printf((info) => {
      const date = new Date();
      const timestamp = `${this.#formatTwoDigits(date.getHours())}:${this.#formatTwoDigits(
        date.getMinutes(),
      )}:${this.#formatTwoDigits(date.getSeconds())}`;
      const level = info.level.toUpperCase();
      const coloredLevel = levelColors[info.level](level);
      return `[${colors.grey(timestamp)}][${coloredLevel}]: ${info.message}`;
    });

    const fileFormat = winston.format.printf((info) => {
      const date = new Date();
      const timestamp = `${this.#formatTwoDigits(date.getHours())}:${this.#formatTwoDigits(
        date.getMinutes(),
      )}:${this.#formatTwoDigits(date.getSeconds())}`;
      return `[${timestamp}][${info.level.toUpperCase()}]: ${info.message}`;
    });

    return winston.createLogger({
      level: 'info',
      transports: [
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

  #formatTwoDigits(n) {
    return n < 10 ? '0' + n : n;
  }

  _getLogger() {
    return Logger.#privateStore.get(this).logger;
  }

  info(message, ...args) {
    this._getLogger().info(this._formatMessage(message, ...args));
  }

  error(message, ...args) {
    this._getLogger().error(this._formatMessage(message, ...args));
  }

  warn(message, ...args) {
    this._getLogger().warn(this._formatMessage(message, ...args));
  }

  debug(message, ...args) {
    this._getLogger().debug(this._formatMessage(message, ...args));
  }

  _formatMessage(message, ...args) {
    if (args.length === 0) {
      return typeof message === 'string' ? message : util.inspect(message, { depth: null });
    }

    if (typeof message === 'string') {
      return util.format(
        message,
        ...args.map((arg) => (typeof arg === 'object' ? util.inspect(arg, { depth: null }) : arg)),
      );
    }

    return [message, ...args]
      .map((arg) => (typeof arg === 'object' ? util.inspect(arg, { depth: null }) : arg))
      .join(' ');
  }
}

const loggerInstance = new Logger();

loggerInstance.Logger = Logger;

module.exports = loggerInstance;

Object.assign(module.exports, {
  Logger,
  default: loggerInstance,
});
