const logger = require('./utils/logger');
const fs = require('fs-extra');
const yaml = require('js-yaml');
const { app } = require('@electron/remote');
const path = require('path');

class Config {
  static instance = null;

  constructor() {
    if (Config.instance) {
      return Config.instance;
    }

    this.default_config = {};
    this.config = {};

    this.defaultDir = path.join(__dirname, '../../resource/config/default.yml');
    this.configDir = path.join(app.getPath('userData'), 'user/config.yml');

    this.checkConfigExists();
    this.readDefaultYaml();
    this.readConfigYaml();
    this.checkConfigVersion();

    Config.instance = this;
  }

  static getInstance() {
    if (!Config.instance) {
      new Config();
    }

    return Config.instance;
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

  writeConfig(config = this.config) {
    logger.debug('Writing config:', JSON.stringify(config, null, 2));

    const lines = [];
    let configContent = fs.readFileSync(this.defaultDir, 'utf8');
    const templateLines = configContent.split('\n');
    let currentKey = '';

    for (const line of templateLines) {
      const keyMatch = line.match(/^(\w+):|^([\w-]+):/);
      const indentedKeyMatch = line.match(/^\s+(\w+):|^\s+([\w-]+):/);

      if (keyMatch) {
        currentKey = keyMatch[1] || keyMatch[2];
        const value = config[currentKey];
        logger.debug(`Processing key: ${currentKey}, value:`, value);

        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          lines.push(`${currentKey}:`);
        }
        else {
          lines.push(`${currentKey}: ${value}`);
        }
      }
      else if (indentedKeyMatch && currentKey) {
        const subKey = indentedKeyMatch[1] || indentedKeyMatch[2];
        if (
          config[currentKey]
          && typeof config[currentKey][subKey] !== 'undefined'
        ) {
          const value = config[currentKey][subKey];
          const comment = line.includes('#') ? ' #' + line.split('#')[1] : '';
          lines.push(`  ${subKey}: ${value}${comment}`);
          logger.debug(`Processing subkey: ${currentKey}.${subKey}, value:`, value);
        }
      }
      else {
        lines.push(line);
      }
    }

    configContent = lines.join('\n');
    logger.debug('New content to write:', configContent);

    try {
      const dir = path.dirname(this.configDir);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(this.configDir, configContent, 'utf8');
      logger.info('Config has been saved to file');
    }
    catch (error) {
      logger.error('Failed to write config:', error);
    }

    this.config = config;
  }

  checkConfigVersion() {
    if (this.default_config.ver > (this.config?.ver ?? 0)) {
      logger.warn(`Updating config from version ${this.config?.ver ?? 0} to ${this.default_config.ver}`);

      let configContent = fs.readFileSync(this.defaultDir, 'utf8');
      const lines = configContent.split('\n');
      const newLines = [];
      let currentKey = '';

      const newConfig = JSON.parse(JSON.stringify(this.default_config));
      for (const key in this.config) {
        if (this.config[key] !== null && this.config[key] !== undefined) {
          if (typeof this.config[key] === 'object' && !Array.isArray(this.config[key])) {
            newConfig[key] = {
              ...newConfig[key],
              ...this.config[key],
            };
          }
          else {
            newConfig[key] = this.config[key];
          }
        }
      }

      newConfig.ver = this.default_config.ver;

      for (const line of lines) {
        const keyMatch = line.match(/^(\w+):|^([\w-]+):/);
        const indentedKeyMatch = line.match(/^\s+(\w+):|^\s+([\w-]+):/);

        if (keyMatch) {
          currentKey = keyMatch[1] || keyMatch[2];
          const value = newConfig[currentKey];

          if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            newLines.push(`${currentKey}:`);
          }
          else {
            newLines.push(`${currentKey}: ${value}`);
          }
        }
        else if (indentedKeyMatch && currentKey) {
          const subKey = indentedKeyMatch[1] || indentedKeyMatch[2];
          if (
            newConfig[currentKey]
            && typeof newConfig[currentKey][subKey] !== 'undefined'
          ) {
            const value = newConfig[currentKey][subKey];
            const comment = line.includes('#') ? ' #' + line.split('#')[1] : '';
            newLines.push(`  ${subKey}: ${value}${comment}`);
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

      this.config = newConfig;
    }
  }

  getConfig(refresh = false) {
    if (refresh) {
      this.readConfigYaml();
    }
    return this.config;
  }
}

new Config();

module.exports = Config;
