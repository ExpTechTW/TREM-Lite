const logger = require('./utils/logger');
const fs = require('fs-extra');
const yaml = require('js-yaml');
const { app } = require('@electron/remote');
const path = require('path');

class config {
  static instance = null;

  constructor() {
    if (config.instance) {
      return config.instance;
    }

    this.default_config = {};
    this.config = {};

    this.defaultDir = path.join(__dirname, '../../resource/config/default.yml');
    this.configDir = path.join(app.getPath('userData'), 'user/config.yml');

    this.checkConfigExists();
    this.readDefaultYaml();
    this.readConfigYaml();
    this.checkConfigVersion();

    config.instance = this;
  }

  static getInstance() {
    if (!config.instance) {
      new config();
    }

    return config.instance;
  }

  checkConfigExists() {
    if (!fs.existsSync(this.configDir)) {
      fs.copySync(this.defaultDir, this.configDir);
    }
  }

  readDefaultYaml() {
    const raw = fs.readFileSync(this.defaultDir).toString();
    this.default_config = yaml.load(raw);
  }

  readConfigYaml() {
    const raw = fs.readFileSync(this.configDir).toString();
    this.config = yaml.load(raw);
  }

  checkConfigVersion() {
    if (this.default_config.ver > (this.config?.ver ?? 0)) {
      logger.warn(`Updating config from version ${this.config?.ver ?? 0} to ${this.default_config.ver}`);

      const existingValues = { ...this.config };

      let configContent = fs.readFileSync(this.defaultDir, 'utf8');
      const lines = configContent.split('\n');
      const newLines = [];
      let currentKey = '';

      for (const line of lines) {
        const keyMatch = line.match(/^(\w+):|^([\w-]+):/);
        const indentedKeyMatch = line.match(/^\s+(\w+):/);

        if (keyMatch) {
          currentKey = keyMatch[1] || keyMatch[2];

          if (currentKey === 'ver') {
            newLines.push(`ver: ${this.default_config.ver}`);
          }
          else if (existingValues[currentKey] !== undefined) {
            const value = existingValues[currentKey];
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
              newLines.push(`${currentKey}:`);
            }
            else {
              newLines.push(`${currentKey}: ${value}`);
            }
          }
          else {
            newLines.push(line);
          }
        }
        else if (indentedKeyMatch && currentKey) {
          const subKey = indentedKeyMatch[1];
          if (existingValues[currentKey]?.[subKey] !== undefined) {
            newLines.push(`  ${subKey}: ${existingValues[currentKey][subKey]}`);
          }
          else {
            newLines.push(line);
          }
        }
        else {
          newLines.push(line);
        }
      }

      configContent = newLines.join('\n');

      const backupPath = `${this.configDir}.backup`;
      fs.copyFileSync(this.configDir, backupPath);
      logger.info(`Backup created at: ${backupPath}`);

      fs.writeFileSync(this.configDir, configContent);
      logger.info('Config file updated successfully');

      this.config = yaml.load(configContent);
    }
  }

  getConfig() {
    return this.config;
  }
}

new config();

module.exports = config;
