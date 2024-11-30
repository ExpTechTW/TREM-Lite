const TREM = require('../index/constant');
const logger = require('./utils/logger');
const { Logger } = require('./utils/logger');
const { app } = require('@electron/remote');
const semver = require('semver');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const MixinManager = require('./mixin');
const acorn = require('acorn');
const walk = require('acorn-walk');

class PluginLoader {
  constructor() {
    this.pluginDir = path.join(app.getPath('userData'), 'plugins');
    this.tempDir = path.join(app.getPath('temp'), 'trem-plugins');
    this.plugins = new Map();
    this.loadOrder = [];
    this.tremVersion = app.getVersion();
    this.extractedPaths = new Map();
    this.eventHandlers = new Map();

    this.availableCtxItems = {
      TREM: 'system',
      events: 'events',
      logger: 'logging',
      Logger: 'logging',
      MixinManager: 'mixin',
      info: 'metadata',
      utils: {
        path: 'filesystem',
        fs: 'filesystem',
        semver: 'version',
      },
      on: 'events',
    };

    this.sensitivityLevels = {
      system: 4,
      filesystem: 3,
      events: 2,
      mixin: 2,
      logging: 1,
      metadata: 1,
      version: 1,
    };

    this.ctx = {
      TREM,
      events: TREM.variable.events,
      logger,
      Logger,
      MixinManager,
      info: {
        pluginDir: this.pluginDir,
        originalPath: null,
      },
      utils: {
        path,
        fs,
        semver,
      },
      on: (event, handler) => {
        const handlers = this.eventHandlers.get(this.currentLoadingPlugin) || new Map();
        handlers.set(event, handler);
        this.eventHandlers.set(this.currentLoadingPlugin, handlers);
      },
      require: (modulePath) => {
        if (modulePath.startsWith('.')) {
          const currentPlugin = this.currentLoadingPlugin;
          if (currentPlugin) {
            if (modulePath.startsWith('../')) {
              const parts = modulePath.split('/');
              const targetPlugin = parts[1];
              const remainingPath = parts.slice(2).join('/');
              const targetPath = path.join(this.tempDir, targetPlugin, remainingPath);
              return require(targetPath);
            }
            else {
              return require(path.resolve(currentPlugin.path, modulePath));
            }
          }
        }
        return require(modulePath);
      },
    };

    this.currentLoadingPlugin = null;

    fs.mkdirSync(this.pluginDir, { recursive: true });
    fs.mkdirSync(this.tempDir, { recursive: true });
  }

  analyzePluginCode(code) {
    const usedDependencies = new Set();
    try {
      const ast = acorn.parse(code, {
        sourceType: 'module',
        ecmaVersion: 'latest',
      });

      walk.simple(ast, {
        VariableDeclarator: (node) => {
          if (node.init?.type === 'MemberExpression' && node.init.object?.name === 'ctx') {
            if (node.id.type === 'ObjectPattern') {
              node.id.properties.forEach((prop) => {
                const key = prop.key.name;
                this.addDependency(key, usedDependencies);
              });
            }
          }
        },
        MemberExpression: (node) => {
          if (node.object?.name === 'ctx') {
            const prop = node.property?.name;
            if (prop) {
              this.addDependency(prop, usedDependencies);
            }
          }
          if (node.object?.type === 'MemberExpression'
            && node.object.object?.name === 'ctx'
            && node.object.property?.name === 'utils') {
            const prop = node.property?.name;
            if (prop) {
              usedDependencies.add(`utils.${prop} (${this.availableCtxItems.utils[prop]})`);
            }
          }
        },
        FunctionDeclaration: (node) => {
          const ctxParam = node.params.find((p) => p.name === 'ctx');
          if (ctxParam) {
            usedDependencies.add('ctx (system)');
          }
        },
        ClassDeclaration: (node) => {
          const constructor = node.body.body.find((m) => m.kind === 'constructor');
          if (constructor) {
            const ctxParam = constructor.value.params.find((p) => p.name === 'ctx');
            if (ctxParam) {
              usedDependencies.add('ctx (system)');
            }
          }
        },
      });

      if (usedDependencies.size === 0 && code.includes('ctx')) {
        usedDependencies.add('ctx (system)');
      }

      return {
        usedDependencies: Array.from(usedDependencies),
        sensitivity: this.calculateSensitivity(usedDependencies),
      };
    }
    catch (error) {
      logger.error('Failed to analyze plugin code:', error);
      if (code) {
        return {
          usedDependencies: ['ctx (system)'],
          sensitivity: { level: 1, description: this.getSensitivityDescription(1) },
        };
      }
      return {
        usedDependencies: [],
        sensitivity: { level: 0, description: '分析失败' },
      };
    }
  }

  addDependency(key, dependencies) {
    if (this.availableCtxItems[key]) {
      if (typeof this.availableCtxItems[key] === 'object') {
        dependencies.add(`${key}.*`);
      }
      else {
        dependencies.add(`${key} (${this.availableCtxItems[key]})`);
      }
    }
  }

  calculateSensitivity(dependencies) {
    let maxSensitivity = 0;
    dependencies.forEach((dep) => {
      const category = dep.match(/\((.*?)\)/)?.[1];
      if (category && this.sensitivityLevels[category]) {
        maxSensitivity = Math.max(maxSensitivity, this.sensitivityLevels[category]);
      }
    });

    return {
      level: maxSensitivity,
      description: this.getSensitivityDescription(maxSensitivity),
    };
  }

  validateDependencies(pluginInfo) {
    if (!pluginInfo.dependencies) {
      return true;
    }

    const { trem, ...pluginDependencies } = pluginInfo.dependencies;

    if (trem) {
      if (!this.validateVersionRequirement(this.tremVersion, trem)) {
        logger.error(`Plugin ${pluginInfo.name} requires TREM version ${trem}, but ${this.tremVersion} is installed`);
        return false;
      }
    }

    for (const [dep, version] of Object.entries(pluginDependencies)) {
      const dependencyPlugin = this.plugins.get(dep);
      if (!dependencyPlugin) {
        logger.error(`Missing dependency: ${dep} for plugin ${pluginInfo.name}`);
        return false;
      }

      if (!this.validateVersionRequirement(dependencyPlugin.info.version, version)) {
        logger.error(`Plugin ${pluginInfo.name} requires ${dep} version ${version}, but ${dependencyPlugin.info.version} is installed`);
        return false;
      }
    }

    return true;
  }

  readPluginInfo(pluginPath) {
    const infoPath = path.join(pluginPath, 'info.json');
    const indexPath = path.join(pluginPath, 'index.js');

    try {
      const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
      if (!info.name) {
        logger.error(`(${infoPath}) -> Plugin info.json must contain a name field`);
        return null;
      }

      info.dependencies = info.dependencies || {};

      if (fs.existsSync(indexPath)) {
        const pluginCode = fs.readFileSync(indexPath, 'utf8');
        const analysis = this.analyzePluginCode(pluginCode);

        info.ctxDependencies = analysis.usedDependencies;
        info.sensitivity = analysis.sensitivity;
      }

      return info;
    }
    catch (error) {
      logger.error(`(${infoPath}) -> Failed to read plugin info:`, error);
      return null;
    }
  }

  getLoadedPlugins() {
    return Array.from(this.plugins.entries()).map(([name, plugin]) => ({
      name,
      version: plugin.info.version,
      description: plugin.info.description,
      author: plugin.info.author,
      ctxDependencies: plugin.info.dependencies?.ctx || [],
      sensitivity: plugin.info.sensitivity || { level: 0, description: '未分析' },
    }));
  }

  getVersionPriority(version) {
    if (!version) {
      return 0;
    }
    const parsed = semver.parse(version);
    if (!parsed) {
      return 0;
    }

    const prerelease = parsed.prerelease[0];
    if (!prerelease) {
      return 3;
    }
    if (prerelease === 'rc') {
      return 2;
    }
    if (prerelease === 'pre') {
      return 1;
    }
    return 0;
  }

  isExactVersionMatch(v1, v2) {
    const parsed1 = semver.parse(v1);
    const parsed2 = semver.parse(v2);

    if (!parsed1 || !parsed2) {
      return false;
    }

    if (parsed1.major !== parsed2.major || parsed1.minor !== parsed2.minor || parsed1.patch !== parsed2.patch) {
      return false;
    }

    const pre1 = parsed1.prerelease;
    const pre2 = parsed2.prerelease;

    if (pre1.length !== pre2.length) {
      return false;
    }
    if (pre1.length === 0) {
      return true;
    }

    return pre1[0] === pre2[0] && pre1[1] === pre2[1];
  }

  compareVersions(v1, v2) {
    const parsed1 = semver.parse(v1);
    const parsed2 = semver.parse(v2);

    if (!parsed1 || !parsed2) {
      return false;
    }

    if (parsed1.major !== parsed2.major) {
      return parsed1.major >= parsed2.major;
    }
    if (parsed1.minor !== parsed2.minor) {
      return parsed1.minor >= parsed2.minor;
    }
    if (parsed1.patch !== parsed2.patch) {
      return parsed1.patch >= parsed2.patch;
    }

    const priority1 = this.getVersionPriority(v1);
    const priority2 = this.getVersionPriority(v2);

    if (priority1 !== priority2) {
      return priority1 >= priority2;
    }
    if (parsed1.prerelease.length > 1 && parsed2.prerelease.length > 1) {
      return parsed1.prerelease[1] >= parsed2.prerelease[1];
    }

    return true;
  }

  validateVersionRequirement(current, required) {
    if (required.includes(' ')) {
      const ranges = required.split(' ');
      return ranges.every((range) => this.validateVersionRequirement(current, range));
    }

    const operator = required.match(/^[>=<]+/)?.[0] || '>=';
    const reqVersion = required.replace(/^[>=<]+/, '');

    switch (operator) {
      case '=': return this.isExactVersionMatch(current, reqVersion);
      case '>=': return this.compareVersions(current, reqVersion);
      case '>': return this.compareVersions(current, reqVersion) && !this.isExactVersionMatch(current, reqVersion);
      case '<': return !this.compareVersions(current, reqVersion);
      case '<=': return !this.compareVersions(current, reqVersion) || this.isExactVersionMatch(current, reqVersion);
      default: return this.compareVersions(current, reqVersion);
    }
  }

  extractTremPlugin(tremFile) {
    try {
      if (this.extractedPaths.has(tremFile)) {
        return this.extractedPaths.get(tremFile);
      }

      logger.info('Extracting plugin:', tremFile);
      const zip = new AdmZip(tremFile);
      const entries = zip.getEntries();

      const pluginName = path.basename(tremFile, '.trem');
      const extractPath = path.join(this.tempDir, pluginName);

      if (fs.existsSync(extractPath)) {
        fs.rmSync(extractPath, { recursive: true });
      }

      const pluginRoot = entries
        .filter((entry) => !entry.entryName.includes('__MACOSX') && !path.basename(entry.entryName).startsWith('._'))
        .reduce((root, entry) => {
          const parts = entry.entryName.split('/');
          return parts[0];
        }, '');

      logger.info('Plugin root directory:', pluginRoot);

      zip.extractAllTo(this.tempDir, true);

      const tempPath = path.join(this.tempDir, pluginRoot);
      if (tempPath !== extractPath && fs.existsSync(tempPath)) {
        if (fs.existsSync(extractPath)) {
          fs.rmSync(extractPath, { recursive: true });
        }
        fs.renameSync(tempPath, extractPath);
      }

      this.extractedPaths.set(tremFile, extractPath);
      return extractPath;
    }
    catch (error) {
      logger.error(`Failed to extract plugin ${tremFile}:`, error);
      return null;
    }
  }

  buildDependencyGraph() {
    const visited = new Set();
    const tempMark = new Set();
    this.loadOrder = [];

    const visit = (pluginName) => {
      if (tempMark.has(pluginName)) {
        throw new Error(`Circular dependency detected: ${pluginName}`);
      }
      if (visited.has(pluginName)) {
        return;
      }

      tempMark.add(pluginName);
      const plugin = this.plugins.get(pluginName);

      if (plugin.dependencies) {
        for (const dep of Object.keys(plugin.dependencies)) {
          if (dep !== 'trem' && this.plugins.has(dep)) {
            visit(dep);
          }
        }
      }

      tempMark.delete(pluginName);
      visited.add(pluginName);
      this.loadOrder.unshift(pluginName);
    };

    for (const pluginName of this.plugins.keys()) {
      if (!visited.has(pluginName)) {
        visit(pluginName);
      }
    }
  }

  isValidPluginClass(PluginClass) {
    if (typeof PluginClass === 'function' && PluginClass.prototype?.constructor === PluginClass) {
      return true;
    }
    return typeof PluginClass === 'function';
  }

  async initializePlugin(pluginName, plugin, PluginClass) {
    try {
      this.currentLoadingPlugin = plugin;
      this.ctx.info.originalPath = plugin.originalPath;

      const isClass = PluginClass.toString().startsWith('class');

      if (isClass) {
        const instance = new PluginClass(this.ctx);
        plugin.instance = instance;

        if (typeof instance.onLoad === 'function') {
          await instance.onLoad();
        }
      }
      else {
        PluginClass(this.ctx);

        const handlers = this.eventHandlers.get(plugin);
        const loadHandler = handlers?.get('load');

        if (loadHandler) {
          await loadHandler();
        }
      }

      logger.info(`Successfully loaded plugin: ${pluginName} (version ${plugin.info.version})`);
      return true;
    }
    catch (error) {
      logger.error(`Failed to initialize plugin ${pluginName}:`, error);
      return false;
    }
    finally {
      this.currentLoadingPlugin = null;
      this.ctx.info.originalPath = null;
    }
  }

  copyToTemp(sourcePath, info) {
    try {
      const targetPath = path.join(this.tempDir, info.name);

      if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { recursive: true });
      }

      fs.cpSync(sourcePath, targetPath, { recursive: true });
      return targetPath;
    }
    catch (error) {
      logger.error(`Failed to copy plugin ${info.name}:`, error);
      return null;
    }
  }

  async scanPlugins() {
    const files = fs.readdirSync(this.pluginDir);
    const allPlugins = new Map();

    for (const file of files) {
      const filePath = path.join(this.pluginDir, file);
      const isDirectory = fs.statSync(filePath).isDirectory();

      if (isDirectory) {
        const info = this.readPluginInfo(filePath);
        if (info) {
          allPlugins.set(info.name, {
            name: info.name,
            version: info.version,
            description: info.description,
            author: info.author,
            ctxDependencies: info.dependencies?.ctx || [],
            sensitivity: info.sensitivity || { level: 0, description: '未分析' },
          });
        }
        continue;
      }

      if (file.endsWith('.trem')) {
        const pluginName = path.basename(file, '.trem');
        if (!allPlugins.has(pluginName)) {
          const extractPath = this.extractTremPlugin(filePath);
          if (extractPath) {
            const info = this.readPluginInfo(extractPath);
            if (info) {
              allPlugins.set(info.name, {
                name: info.name,
                version: info.version,
                description: info.description,
                author: info.author,
                ctxDependencies: info.dependencies?.ctx || [],
                sensitivity: info.sensitivity || { level: 0, description: '未分析' },
              });
            }
          }
        }
      }
    }

    const pluginList = Array.from(allPlugins.values());
    localStorage.setItem('plugin-list', JSON.stringify(pluginList));
    return pluginList;
  }

  getSensitivityDescription(level) {
    switch (level) {
      case 4: return '極高敏感度 - 包含系統核心API存取權限';
      case 3: return '高敏感度 - 包含檔案系統存取權限';
      case 2: return '中等敏感度 - 包含事件或混入系統權限';
      case 1: return '低敏感度 - 包含日誌/元數據/版本資訊存取';
      default: return '無敏感操作';
    }
  }

  async loadPlugins() {
    logger.info(`Loading plugins (TREM version: ${this.tremVersion})`);
    this.plugins.clear();
    this.loadOrder = [];

    const files = fs.readdirSync(this.pluginDir);
    const enabledPlugins = JSON.parse(localStorage.getItem('enabled-plugins') || '[]');

    for (const file of files) {
      const filePath = path.join(this.pluginDir, file);
      const isDirectory = fs.statSync(filePath).isDirectory();

      let targetPath;
      let originalPath = filePath;

      if (isDirectory) {
        const info = this.readPluginInfo(filePath);
        if (info) {
          targetPath = this.copyToTemp(filePath, info);
        }
      }
      else if (file.endsWith('.trem')) {
        targetPath = this.extractTremPlugin(filePath);
        originalPath = path.join(this.pluginDir, path.basename(file, '.trem'));
      }

      if (targetPath) {
        const info = this.readPluginInfo(targetPath);
        if (info && enabledPlugins.includes(info.name)) {
          this.plugins.set(info.name, {
            path: targetPath,
            originalPath,
            info,
            dependencies: info.dependencies || {},
          });
        }
      }
    }

    for (const [pluginName, plugin] of this.plugins.entries()) {
      if (!this.validateDependencies(plugin.info)) {
        this.plugins.delete(pluginName);
        logger.warn(`Skipping plugin ${pluginName} due to dependency issues`);
      }
    }

    try {
      this.buildDependencyGraph();
    }
    catch (error) {
      logger.error('Failed to resolve plugin dependencies:', error);
      return;
    }

    for (const pluginName of this.loadOrder) {
      const plugin = this.plugins.get(pluginName);
      const indexPath = path.join(plugin.path, 'index.js');

      try {
        if (fs.existsSync(indexPath)) {
          const PluginClass = require(indexPath);

          if (this.isValidPluginClass(PluginClass)) {
            const success = await this.initializePlugin(pluginName, plugin, PluginClass);
            if (!success) {
              this.plugins.delete(pluginName);
            }
          }
          else {
            logger.error(`Plugin ${pluginName} does not export a valid plugin class`);
            this.plugins.delete(pluginName);
          }
        }
      }
      catch (error) {
        logger.error(`Failed to load plugin ${pluginName}:`, error);
        this.plugins.delete(pluginName);
      }
    }

    localStorage.setItem('loaded-plugins', JSON.stringify(this.getLoadedPlugins()));
  }

  async unloadPlugin(pluginName) {
    const plugin = this.plugins.get(pluginName);
    if (plugin?.instance) {
      if (typeof plugin.instance.onUnload === 'function') {
        await plugin.instance.onUnload();
      }
      this.plugins.delete(pluginName);
    }
  }
}

// const manager = require('./manager');
// manager.enable('test');
// manager.enable('exptech');
// manager.enable('websocket');

const pluginLoader = new PluginLoader();

(async () => {
  await pluginLoader.scanPlugins();
  await pluginLoader.loadPlugins();

  const info = {
    version: pluginLoader.tremVersion,
    pluginList: JSON.parse(localStorage.getItem('plugin-list') || '[]'),
    enabledPlugins: JSON.parse(localStorage.getItem('enabled-plugins') || '[]'),
    loadedPlugins: pluginLoader.getLoadedPlugins(),
    pluginCount: pluginLoader.plugins.size,
    pluginDir: pluginLoader.pluginDir,
    tempDir: pluginLoader.tempDir,
  };

  logger.info('Plugin system initialized:', info);
})();

module.exports = {
  default: PluginLoader,
  pluginLoader,
};
