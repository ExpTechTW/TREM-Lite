const TREM = require('../index/constant');
const logger = require('./utils/logger');
const { Logger } = require('./utils/logger');
const { app } = require('@electron/remote');
const path = require('path');
const fs = require('fs-extra');
const AdmZip = require('adm-zip');
const MixinManager = require('./mixin');
const PluginVerifier = require('./verify');
const crypto = require('crypto');
const manager = require('./manager');
const { ipcRenderer } = require('electron');
const now = require('../index/utils/ntp');

class PluginLoader {
  static instance = null;

  constructor(type = 'index') {
    if (PluginLoader.instance) {
      return PluginLoader.instance;
    }

    this.type = type;

    if (this.type == 'index') {
      ipcRenderer.on('auto-download', () => this.checkAutoDownload());
    }

    const keysDir = path.join(app.getPath('userData'), 'keys');
    fs.mkdirSync(keysDir, { recursive: true });

    const officialKey = `-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzQn1ouv0mfzVKJevJiq+\n6rV9mwCEvQpauQ2QNjy4TiwhqzqNiOPwpM3qo+8+3Ld+DUhzZzSzyx894dmJGlWQ\nwNss9Vs5/gnuvn6PurNXC42wkxY6Dmsnp/M6g08iqGXVcM6ZWmvCZ3BzBvwExxRR\n09KxHZVhwoMcF5Kp9l/hNZqXRgYMn3GLt+m78Hr+ZUjHiF8K9UH2TPxKRa/4ttPX\n6nDBZxZUCwFD7Zh6RePg07JDbO5fI/UYrqZYyDPK8w9xdXtke9LbdXmMuuk/x57h\nfoRArUkhPvUk/77mxo4++3EFnTUxYMnQVuMkDaYNRu7w83abUuhsjNlL/es24HSm\nlwIDAQAB\n-----END PUBLIC KEY-----`;

    this.verifier = new PluginVerifier(officialKey);

    this.verifier.loadKeysFromDirectory(keysDir);
    this.pluginDir = path.join(app.getPath('userData'), 'plugins');
    this.tempDir = path.join(app.getPath('userData'), 'plugins-temp');
    this.plugins = {};
    this.plugins[this.type] = new Map();
    this.loadOrder = [];
    this.scannedPlugins = new Map();
    this.tremVersion = app.getVersion();
    this.eventHandlers = new Map();
    this.pluginStatus = [];

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
      },
      on: 'events',
    };

    this.sensitivityLevels = {
      system: 4,
      filesystem: 3,
      events: 2,
      mixin: 3,
      logging: 1,
      metadata: 1,
      version: 0,
    };

    this.ctx = {
      TREM,
      events: TREM.variable.events,
      logger,
      Logger,
      MixinManager,
      info: {
        pluginDir: this.tempDir,
        originalPath: this.pluginDir,
      },
      utils: {
        path,
        fs,
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

    PluginLoader.instance = this;
  }

  static getInstance() {
    if (!PluginLoader.instance) {
      new PluginLoader();
    }

    return PluginLoader.instance;
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
        this.pluginStatus.push({
          type: 'error',
          time: now(),
          plugin: pluginInfo.name,
          msg: `需要至少 TREM-Lite 的版本為 ${trem} 以上，但目前安裝的版本為 ${this.tremVersion}。`,
        });
        logger.error(`Plugin ${pluginInfo.name} requires TREM version ${trem}, but ${this.tremVersion} is installed`);
        return false;
      }
    }

    for (const [dep, version] of Object.entries(pluginDependencies)) {
      const dependencyPlugin = this.plugins[this.type].get(dep);
      if (!dependencyPlugin) {
        this.pluginStatus.push({
          type: 'error',
          time: now(),
          plugin: pluginInfo.name,
          msg: `缺少 ${dep} 依賴。`,
        });
        logger.error(`Missing dependency: ${dep} for plugin ${pluginInfo.name}`);
        return false;
      }

      if (!this.validateVersionRequirement(dependencyPlugin.info.version, version)) {
        this.pluginStatus.push({
          type: 'error',
          time: now(),
          plugin: pluginInfo.name,
          msg: `需要至少 ${dep} 的版本為 ${version} 以上，但目前安裝的版本為 ${dependencyPlugin.info.version}。`,
        });
        logger.error(`Plugin ${pluginInfo.name} requires ${dep} version ${version}, but ${dependencyPlugin.info.version} is installed`);
        return false;
      }
    }

    return true;
  }

  readPluginInfo(pluginPath) {
    const infoPath = path.join(pluginPath, 'info.json');

    try {
      const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));

      if (!info || !info.name) {
        logger.error(`${infoPath} -> Plugin info.json must contain a name field`);
        return null;
      }

      const isValidName = /^[a-z0-9-]+$/.test(info.name);

      if (!isValidName) {
        logger.error(`Plugin name "${info.name}" is invalid. Only English letters, hyphens and underscores are allowed`);
        return null;
      }

      info.dependencies = info.dependencies || {};

      return info;
    }
    catch (error) {
      logger.error(`${infoPath} -> Failed to read plugin info:`, error);
      return null;
    }
  }

  getLoadedPlugins() {
    return Array.from(this.plugins[this.type].entries()).map(([name, plugin]) => ({
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
    const parsed = this.parseVersion(version);
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
    const parsed1 = this.parseVersion(v1);
    const parsed2 = this.parseVersion(v2);

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
    const parsed1 = this.parseVersion(v1);
    const parsed2 = this.parseVersion(v2);

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
      const plugin = this.plugins[this.type].get(pluginName);

      if (plugin.dependencies) {
        for (const dep of Object.keys(plugin.dependencies)) {
          if (dep !== 'trem' && this.plugins[this.type].has(dep)) {
            visit(dep);
          }
        }
      }

      tempMark.delete(pluginName);
      visited.add(pluginName);
      this.loadOrder.unshift(pluginName);
    };

    for (const pluginName of this.plugins[this.type].keys()) {
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
      this.pluginStatus.push({
        type: 'error',
        time: now(),
        plugin: pluginName,
        msg: `初始化失敗，請聯繫擴充作者。`,
      });
      logger.error(`Failed to initialize plugin ${pluginName}:`, error);
      return false;
    }
    finally {
      this.currentLoadingPlugin = null;
    }
  }

  hasDirectoryChanged(dirPath, oldState = {}) {
    try {
      const files = fs.readdirSync(dirPath);
      const currentState = {
        files: {},
        totalSize: 0,
        lastModified: 0,
      };

      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stats = fs.statSync(filePath);

        if (stats.isDirectory()) {
          const subDirState = this.hasDirectoryChanged(filePath, oldState.files?.[file]);
          currentState.files[file] = subDirState.currentState;
          currentState.totalSize += subDirState.currentState.totalSize;
          currentState.lastModified = Math.max(currentState.lastModified, subDirState.currentState.lastModified);

          if (subDirState.hasChanged) {
            return { hasChanged: true, currentState };
          }
        }
        else {
          currentState.files[file] = {
            size: stats.size,
            mtime: stats.mtimeMs,
          };
          currentState.totalSize += stats.size;
          currentState.lastModified = Math.max(currentState.lastModified, stats.mtimeMs);
        }
      }

      const hasChanged = !oldState.files
        || oldState.totalSize !== currentState.totalSize
        || oldState.lastModified !== currentState.lastModified;

      return { hasChanged, currentState };
    }
    catch (error) {
      logger.error('Error checking directory changes:', error);
      return { hasChanged: true, currentState: null };
    }
  }

  hasFileChanged(filePath) {
    try {
      const stats = fs.statSync(filePath);
      const currentState = {
        size: stats.size,
        mtime: stats.mtimeMs,
      };

      const isDirectory = stats.isDirectory();
      const tremInfo = this.readTremInfoFile(filePath);
      const oldState = tremInfo?.fileState;

      if (isDirectory) {
        const dirState = this.hasDirectoryChanged(filePath, oldState);
        return {
          hasChanged: dirState.hasChanged,
          currentState: dirState.currentState,
        };
      }

      const hasChanged = !oldState
        || oldState.size !== currentState.size
        || oldState.mtime !== currentState.mtime;

      return { hasChanged, currentState };
    }
    catch {
      return { hasChanged: true, currentState: null };
    }
  }

  createTremInfoFile(pluginPath, data) {
    const tremJsonPath = path.join(pluginPath, 'trem.json');
    try {
      const existingData = this.readTremInfoFile(pluginPath) || {};
      const updatedData = { ...existingData, ...data };
      fs.writeFileSync(tremJsonPath, JSON.stringify(updatedData, null, 2));
    }
    catch (error) {
      logger.error('Error creating trem.json:', error);
    }
  }

  readTremInfoFile(pluginPath) {
    const tremJsonPath = path.join(pluginPath, 'trem.json');
    try {
      if (fs.existsSync(tremJsonPath)) {
        return JSON.parse(fs.readFileSync(tremJsonPath, 'utf8'));
      }
      return null;
    }
    catch (error) {
      logger.error('Error reading trem.json:', error);
      return null;
    }
  }

  async extractTremPlugin(tremFile) {
    try {
      const extractPath = path.join(this.tempDir, path.basename(tremFile, '.trem'));
      let finalPath = extractPath;

      const tremInfo = this.readTremInfoFile(extractPath);
      const { hasChanged, currentState } = this.hasFileChanged(tremFile);

      const needExtract = !tremInfo || hasChanged || !fs.existsSync(extractPath);

      if (!needExtract) {
        logger.debug('Plugin unchanged, using existing files:', extractPath);
        return extractPath;
      }

      logger.info('Extracting plugin:', tremFile);
      const zip = new AdmZip(tremFile);
      const entries = zip.getEntries();

      const tempExtractPath = path.join(this.tempDir, `${path.basename(tremFile, '.trem')}_temp`);

      if (fs.existsSync(tempExtractPath)) {
        await fs.remove(tempExtractPath);
      }

      const validEntries = entries.filter((entry) =>
        !entry.entryName.includes('__MACOSX')
        && !path.basename(entry.entryName).startsWith('._'),
      );

      if (validEntries.length === 0) {
        logger.error('No valid entries found in plugin archive');
        return null;
      }

      await fs.ensureDir(tempExtractPath);

      const firstEntry = validEntries[0].entryName.split('/')[0];
      const hasCommonRoot = validEntries.every((entry) => {
        const parts = entry.entryName.split('/');
        return parts.length > 1 && parts[0] === firstEntry;
      });

      if (hasCommonRoot) {
        zip.extractAllTo(this.tempDir, true);
        await fs.move(path.join(this.tempDir, firstEntry), tempExtractPath, { overwrite: true });
      }
      else {
        zip.extractAllTo(tempExtractPath, true);
      }

      const infoPath = path.join(tempExtractPath, 'info.json');
      if (fs.existsSync(infoPath)) {
        try {
          const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
          if (info && info.name) {
            finalPath = path.join(this.tempDir, info.name);
          }
        }
        catch (error) {
          logger.error('Error parsing info.json:', error);
        }
      }

      if (fs.existsSync(finalPath)) {
        await fs.remove(finalPath);
      }

      await fs.move(tempExtractPath, finalPath, { overwrite: true });

      const verification = this.verifier.verify(finalPath);

      const pluginInfo = this.readPluginInfo(finalPath);

      this.createTremInfoFile(finalPath, {
        fileState: currentState,
        lastExtracted: Date.now(),
        originalPath: tremFile,
        tremMD5: this.calculateMD5(tremFile),
        verification,
        pluginInfo,
      });

      return finalPath;
    }
    catch (error) {
      logger.error(`Failed to extract plugin ${tremFile}:`, error.message);
      return null;
    }
  }

  calculateMD5(filePath) {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(content).digest('hex');
  }

  async cleanupOrphanedPlugins() {
    logger.debug('Cleaning up orphaned plugin data...');

    const tempFiles = fs.readdirSync(this.tempDir);

    for (const file of tempFiles) {
      if (file === '_temp_extract' || file.endsWith('_temp')) {
        continue;
      }

      const tempPath = path.join(this.tempDir, file);
      if (fs.statSync(tempPath).isDirectory()) {
        if (!this.scannedPlugins.has(file)) {
          try {
            logger.debug(`Removing orphaned plugin directory: ${file}`);
            await fs.remove(tempPath);
            manager.disable(file);
          }
          catch (error) {
            logger.error(`Error removing orphaned plugin directory ${file}:`, error);
          }
        }
      }
    }

    logger.info('Orphaned plugin cleanup completed');
  }

  async scanPlugins() {
    const files = fs.readdirSync(this.pluginDir);
    const pluginPaths = new Map();
    const processedPlugins = new Set();
    const allPlugins = new Map();

    for (const file of files) {
      try {
        const filePath = path.join(this.pluginDir, file);
        const stats = fs.statSync(filePath);

        if (stats.isDirectory()) {
          const infoPath = path.join(filePath, 'info.json');
          if (fs.existsSync(infoPath)) {
            const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
            if (info?.name) {
              logger.debug(`[Plugin: ${info.name}] Found directory plugin`);
              pluginPaths.set(info.name, {
                path: filePath,
                type: 'directory',
              });
            }
          }
        }
      }
      catch (error) {
        logger.error(`Error processing directory ${file}:`, error);
      }
    }

    for (const file of files) {
      try {
        if (file.endsWith('.trem')) {
          const pluginName = file.replace('.trem', '');
          if (pluginPaths.has(pluginName)) {
            logger.info(`[Plugin: ${pluginName}] Directory version exists, skipping TREM package`);
            continue;
          }
          const filePath = path.join(this.pluginDir, file);
          pluginPaths.set(pluginName, {
            path: filePath,
            type: 'trem',
          });
          logger.debug(`[Plugin: ${pluginName}] Found TREM package`);
        }
      }
      catch (error) {
        logger.error(`Error processing file ${file}:`, error);
      }
    }

    try {
      const tempFiles = fs.readdirSync(this.tempDir);
      for (const tempFile of tempFiles) {
        if (tempFile.startsWith('_temp_extract_')) {
          const tempPath = path.join(this.tempDir, tempFile);
          try {
            await fs.remove(tempPath);
          }
          catch (error) {
            logger.error(`Error removing temp directory ${tempPath}:`, error);
          }
        }
      }
    }
    catch (error) {
      logger.error('Error cleaning temp directories:', error);
    }

    for (const [pluginName, pathInfo] of pluginPaths) {
      if (processedPlugins.has(pluginName)) {
        logger.debug(`[Plugin: ${pluginName}] Already processed, skipping`);
        continue;
      }

      try {
        const { path: sourcePath, type } = pathInfo;
        const targetPath = path.join(this.tempDir, pluginName);
        logger.info(`[Plugin: ${pluginName}] Processing plugin type: ${type}`);

        if (type === 'directory') {
          await this.processDirectoryPlugin(pluginName, sourcePath, targetPath);
        }
        else if (type === 'trem') {
          await this.processTremPlugin(pluginName, sourcePath, targetPath);
        }

        const tremInfo = this.readTremInfoFile(targetPath);
        const verified = tremInfo?.verification?.valid || false;

        if (!verified && tremInfo?.verification?.error == 'Missing signature.json') {
          this.pluginStatus.push({
            type: 'error',
            time: now(),
            plugin: pluginName,
            msg: `【!!!嚴重警告!!!】遺失簽名。`,
          });
          logger.error(`[Plugin: ${pluginName}] 【!!!嚴重警告!!!】遺失簽名, Skipping plugin`);
          logger.error(`[Plugin: ${pluginName}] 【!!!WARNING!!!】Missing signature, Skipping plugin`);
          continue;
        }
        else if (!verified) {
          this.pluginStatus.push({
            type: 'warn',
            time: now(),
            plugin: pluginName,
            msg: `【!!!嚴重警告!!!】未發現有效簽名，除非信任擴充來源否則應立即停用。`,
          });
          logger.warn(`[Plugin: ${pluginName}] 【!!!嚴重警告!!!】未發現有效簽名，除非信任擴充來源否則應立即停用`);
          logger.warn(`[Plugin: ${pluginName}] 【!!!WARNING!!!】No valid signature found, disable immediately unless plugin source is trusted`);
        }

        if (fs.existsSync(targetPath) && tremInfo) {
          const pluginData = {
            name: pluginName,
            version: tremInfo.pluginInfo.version,
            description: tremInfo.pluginInfo.description,
            author: tremInfo.pluginInfo.author,
            verified,
            verifyError: tremInfo.verification?.error || null,
            keyId: tremInfo.verification?.keyId || null,
            ctxDependencies: tremInfo.pluginInfo?.ctxDependencies || [],
            sensitivity: tremInfo.pluginInfo?.sensitivity || { level: 0, description: '未分析' },
            path: targetPath,
            originalPath: sourcePath,
            info: tremInfo.pluginInfo || {},
            dependencies: tremInfo.pluginInfo.dependencies || {},
            type,
            lastUpdated: tremInfo.lastUpdated || Date.now(),
          };

          if (!tremInfo.pluginInfo) {
            logger.error(`[Plugin: ${pluginName}] Plugin fails to load, please contact the plugin developer!`);
            fs.removeSync(targetPath);
          }
          else {
            allPlugins.set(pluginName, pluginData);
          }

          processedPlugins.add(pluginName);
        }
      }
      catch (error) {
        logger.error(`[Plugin: ${pluginName}] Error:`, error);
      }
    }

    localStorage.setItem('plugin-list', JSON.stringify(Array.from(allPlugins.values())));
    return allPlugins;
  }

  normalizeContent(content) {
    return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  calculateFileContentMD5(filePath) {
    try {
      const content = fs.readFileSync(filePath).toString();
      return crypto.createHash('sha256').update(this.normalizeContent(content)).digest('hex');
    }
    catch (error) {
      logger.error(`Error calculating content MD5 for ${filePath}:`, error);
      return null;
    }
  }

  async processDirectoryPlugin(pluginName, sourcePath, targetPath) {
    try {
      const expectedFiles = new Map();

      const ignoreDirs = [];
      const ignoreFiles = [
        'package.json',
        'package-lock.json',
        'LICENSE',
        'README.md',
      ];

      const readDirRecursive = (dir, base = '') => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.')) {
            continue;
          }

          const fullPath = path.join(dir, entry.name);
          const relativePath = path.join(base, entry.name);

          if (entry.isDirectory()) {
            if (entry.name.startsWith('.') || ignoreDirs.includes(entry.name)) {
              continue;
            }
            readDirRecursive(fullPath, relativePath);
          }
          else {
            if (entry.name.startsWith('.') || ignoreFiles.includes(entry.name)) {
              continue;
            }
            expectedFiles.set(relativePath, fullPath);
          }
        }
      };

      readDirRecursive(sourcePath);
      await fs.ensureDir(targetPath);

      const filesToUpdate = [];
      for (const [relativePath, sourceFilePath] of expectedFiles) {
        const targetFilePath = path.join(targetPath, relativePath);
        const normalizedPath = relativePath.replace(/\\/g, '/');

        let needUpdate = false;

        if (!fs.existsSync(targetFilePath)) {
          logger.warn(`[Plugin: ${pluginName}] Missing file: ${normalizedPath}`);
          needUpdate = true;
        }
        else {
          const currentHash = this.calculateFileContentMD5(targetFilePath);
          const sourceHash = this.calculateFileContentMD5(sourceFilePath);
          if (!currentHash || !sourceHash) {
            logger.error(`[Plugin: ${pluginName}] Failed to calculate hash for: ${normalizedPath}`);
            continue;
          }

          if (sourceHash !== currentHash) {
            logger.warn(`[Plugin: ${pluginName}] Content hash mismatch for ${normalizedPath}`);
            needUpdate = true;
          }
        }

        if (needUpdate) {
          filesToUpdate.push({
            source: sourceFilePath,
            target: targetFilePath,
            path: normalizedPath,
          });
        }
      }

      if (filesToUpdate.length > 0) {
        logger.info(`[Plugin: ${pluginName}] Updating ${filesToUpdate.length} files`);
        for (const file of filesToUpdate) {
          try {
            await fs.ensureDir(path.dirname(file.target));
            await fs.copyFile(file.source, file.target);
          }
          catch (error) {
            logger.error(`[Plugin: ${pluginName}] Error updating ${file.path}:`, error);
          }
        }

        const verification = this.verifier.verify(targetPath);
        const pluginInfo = this.readPluginInfo(targetPath);
        this.createTremInfoFile(targetPath, {
          lastUpdated: Date.now(),
          verification,
          pluginInfo,
        });
        logger.info(`[Plugin: ${pluginName}] Plugin info updated`);
      }
    }
    catch (error) {
      logger.error(`[Plugin: ${pluginName}] Error processing directory:`, error);
    }
  }

  async processTremPlugin(pluginName, sourcePath, targetPath) {
    try {
      const tremInfo = this.readTremInfoFile(targetPath);
      const currentMD5 = this.calculateMD5(sourcePath);
      let needUpdate = false;

      const signaturePath = path.join(targetPath, 'signature.json');
      let expectedFiles = {};
      if (fs.existsSync(signaturePath)) {
        try {
          const signatureData = JSON.parse(fs.readFileSync(signaturePath, 'utf8'));
          expectedFiles = signatureData.fileHashes || {};

          if (fs.existsSync(targetPath)) {
            const existingFiles = new Set();
            const processDirectory = (dir) => {
              const items = fs.readdirSync(dir);
              for (const item of items) {
                const fullPath = path.join(dir, item);
                const relativePath = path.relative(targetPath, fullPath).replace(/\\/g, '/');
                if (fs.statSync(fullPath).isDirectory()) {
                  processDirectory(fullPath);
                }
                else {
                  existingFiles.add(relativePath);
                }
              }
            };
            processDirectory(targetPath);

            for (const file of Object.keys(expectedFiles)) {
              const normalizedPath = file.replace(/\\/g, '/');
              if (!existingFiles.has(normalizedPath)) {
                logger.info(`[Plugin: ${pluginName}] Missing file: ${normalizedPath}`);
                needUpdate = true;
              }
            }
          }
        }
        catch (error) {
          logger.error(`[Plugin: ${pluginName}] Error reading signature:`, error);
          needUpdate = true;
        }
      }
      else {
        needUpdate = true;
      }

      if (!tremInfo || !tremInfo.tremMD5 || tremInfo.tremMD5 !== currentMD5) {
        needUpdate = true;
      }

      if (needUpdate) {
        logger.info(`[Plugin: ${pluginName}] Extracting package`);
        await this.extractTremPlugin(sourcePath);
      }
    }
    catch (error) {
      logger.error(`[Plugin: ${pluginName}] Error processing TREM package:`, error);
    }
  }

  getSensitivityDescription(level) {
    switch (level) {
      case 4: return '極高敏感度 - 包含系統核心API存取權限';
      case 3: return '高敏感度 - 包含注入或檔案系統存取權限';
      case 2: return '中等敏感度 - 包含事件權限';
      case 1: return '低敏感度 - 包含日誌/元數據存取';
      default: return '無敏感操作';
    }
  }

  async loadPlugins() {
    logger.info(`Loading plugins (TREM version: ${this.tremVersion})`);
    this.plugins[this.type].clear();
    this.loadOrder = [];

    const enabledPlugins = JSON.parse(localStorage.getItem('enabled-plugins') || '[]');
    this.scannedPlugins = await this.scanPlugins();

    for (const [name, pluginData] of this.scannedPlugins.entries()) {
      const isValidPlugin
      = pluginData.info?.['auto-enable'] == true
      && pluginData.info?.author.includes('ExpTechTW')
      && pluginData.verified == true;
      if (isValidPlugin) {
        manager.enable(pluginData.name);
      }
      const loader = !pluginData.info.loader ? ['index'] : pluginData.info.loader;
      if (!loader.includes(this.type)) {
        continue;
      }
      if (enabledPlugins.includes(name) || isValidPlugin) {
        if (!pluginData.verified) {
          logger.debug(`Loading unverified plugin ${name}: ${pluginData.verifyError}`);
        }
        this.plugins[this.type].set(name, pluginData);
      }
      else if (!enabledPlugins.includes(name)) {
        this.pluginStatus.push({
          type: 'warn',
          time: now(),
          plugin: name,
          msg: `未啟用。`,
        });
        logger.warn(`--- Plugin ${name} disable ---`);
      }
    }

    for (const [pluginName, plugin] of this.plugins[this.type].entries()) {
      if (!this.validateDependencies(plugin.info)) {
        this.plugins[this.type].delete(pluginName);
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
      const plugin = this.plugins[this.type].get(pluginName);
      const indexPath = path.join(plugin.path, 'index.js');

      try {
        if (fs.existsSync(indexPath)) {
          const PluginClass = require(indexPath);

          if (this.isValidPluginClass(PluginClass)) {
            const success = await this.initializePlugin(pluginName, plugin, PluginClass);
            if (!success) {
              this.plugins[this.type].delete(pluginName);
            }
          }
          else {
            logger.error(`Plugin ${pluginName} does not export a valid plugin class`);
            this.plugins[this.type].delete(pluginName);
          }
        }
      }
      catch (error) {
        logger.error(`Failed to load plugin ${pluginName}:`, error);
        this.plugins[this.type].delete(pluginName);
      }
    }

    this.cleanupOrphanedPlugins(this.scannedPlugins);

    const previousList = JSON.parse(localStorage.getItem('loaded-plugins')) || [];

    const currentLoadedPlugins = this.getLoadedPlugins();

    const updatedList = [
      ...previousList.filter((plugin) => !currentLoadedPlugins.some((current) => current.name === plugin.name)),
      ...currentLoadedPlugins,
    ];

    if (this.type == 'index') {
      localStorage.setItem('plugin-status', JSON.stringify(this.pluginStatus));
    }
    localStorage.setItem('loaded-plugins', JSON.stringify(updatedList));

    this.checkAutoDownload();
  }

  checkAutoDownload() {
    const auto_download = localStorage.getItem('pendingInstallPlugin') ?? '';
    if (auto_download) {
      localStorage.removeItem('pendingInstallPlugin');
      this.autoDownload(auto_download);
    }
  }

  async deletePlugin(name) {
    const info = this.scannedPlugins.get(name);

    if (info) {
      fs.removeSync(info.originalPath);
      fs.removeSync(info.path);
    }
  }

  async autoDownload(args) {
    logger.warn('Auto download: ', args);
    const params = args.split('@');
    await this.downloadPlugin(params[0], params[1]);
    ipcRenderer.send('all-reload');
  }

  parseVersion(version) {
    const regex = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+([\w.-]+))?$/;
    const match = version.match(regex);

    if (!match) {
      return null;
    }

    return {
      major: parseInt(match[1], 10),
      minor: parseInt(match[2], 10),
      patch: parseInt(match[3], 10),
      prerelease: match[4] ? match[4].split('.') : [],
      build: match[5] ? match[5].split('.') : [],
      version,
    };
  }
}

function createPluginLoader(type) {
  const pluginLoader = new PluginLoader(type);
  pluginLoader.loadPlugins();

  return pluginLoader;
}

module.exports = {
  default: PluginLoader,
  createPluginLoader,
};
