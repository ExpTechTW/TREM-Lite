const pino = require('pino');
const path = require('path');
const { app } = require('@electron/remote');
const fs = require('fs');
const util = require('util');
const { compress } = require('zstd-napi');

const LOG_MAX_FILES = 7;

const ansiColors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  grey: '\x1b[90m',
};

const levelColorMap = {
  10: ansiColors.grey,
  20: ansiColors.blue,
  30: ansiColors.green,
  40: ansiColors.yellow,
  50: ansiColors.red,
  60: ansiColors.red,
};

const levelLabelMap = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

function formatTimestamp() {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function getDateString() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function compressWithZstd(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    const compressed = compress(data);
    fs.writeFileSync(`${filePath}.zst`, compressed);
    fs.unlinkSync(filePath);
  }
  catch {
    // compression failed, keep uncompressed
  }
}

function cleanOldLogs(logDir) {
  try {
    const files = fs.readdirSync(logDir)
      .filter((f) => f.endsWith('.log') || f.endsWith('.log.zst'))
      .map((f) => ({ name: f, time: fs.statSync(path.join(logDir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);

    for (const file of files.slice(LOG_MAX_FILES)) {
      fs.unlinkSync(path.join(logDir, file.name));
    }
  }
  catch {
    // ignore cleanup errors
  }
}

function rotateLogs(logDir, currentFile) {
  try {
    const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.log'));
    for (const file of files) {
      const filePath = path.join(logDir, file);
      if (filePath !== currentFile) {
        compressWithZstd(filePath);
      }
    }
  }
  catch {
    // ignore rotation errors
  }

  cleanOldLogs(logDir);
}

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
    const logDir = app.getPath('logs');
    fs.mkdirSync(logDir, { recursive: true });

    const logFile = path.join(logDir, `${getDateString()}.log`);

    rotateLogs(logDir, logFile);

    const fileStream = pino.destination({
      dest: logFile,
      sync: false,
      mkdir: true,
    });

    this._logDir = logDir;
    this._currentDate = getDateString();
    this._fileStream = fileStream;

    const streams = [
      {
        level: 'info',
        stream: {
          write: (chunk) => {
            const obj = JSON.parse(chunk);
            const ts = formatTimestamp();
            const label = levelLabelMap[obj.level] || 'LOG';
            const color = levelColorMap[obj.level] || '';
            const coloredLevel = `${color}${label}${ansiColors.reset}`;
            process.stdout.write(`[${ansiColors.grey}${ts}${ansiColors.reset}][${coloredLevel}]: ${obj.msg}\n`);
          },
        },
      },
      {
        level: 'info',
        stream: {
          write: (chunk) => {
            const obj = JSON.parse(chunk);
            const ts = formatTimestamp();
            const label = levelLabelMap[obj.level] || 'LOG';
            const line = `[${ts}][${label}]: ${obj.msg}\n`;

            const today = getDateString();
            if (today !== this._currentDate) {
              const oldFile = path.join(this._logDir, `${this._currentDate}.log`);
              this._currentDate = today;
              const newFile = path.join(this._logDir, `${today}.log`);

              this._fileStream.end();
              this._fileStream = pino.destination({ dest: newFile, sync: false, mkdir: true });

              compressWithZstd(oldFile);
              cleanOldLogs(this._logDir);
            }

            this._fileStream.write(line);
          },
        },
      },
    ];

    return pino(
      { level: 'info', timestamp: false },
      pino.multistream(streams),
    );
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
      return typeof message === 'string' ? message : util.inspect(message, { depth: 4, maxStringLength: 1024 });
    }

    if (typeof message === 'string') {
      return util.format(
        message,
        ...args.map((arg) => (typeof arg === 'object' ? util.inspect(arg, { depth: 4, maxStringLength: 1024 }) : arg)),
      );
    }

    return [message, ...args]
      .map((arg) => (typeof arg === 'object' ? util.inspect(arg, { depth: 4, maxStringLength: 1024 }) : arg))
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
