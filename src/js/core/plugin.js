const TREM = require('../index/constant');
const logger = require('./utils/logger');
const { Logger } = require('./utils/logger');
const { app } = require('@electron/remote');
const semver = require('semver');
const path = require('path');
const fs = require('fs-extra');
const AdmZip = require('adm-zip');
const MixinManager = require('./mixin');
const acorn = require('acorn');
const walk = require('acorn-walk');
const PluginVerifier = require('./verify');
const crypto = require('crypto');
const manager = require('./manager');

class PluginLoader {
  constructor() {
    const keysDir = path.join(app.getPath('userData'), 'keys');
    fs.mkdirSync(keysDir, { recursive: true });

    const officialKey = `-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzQn1ouv0mfzVKJevJiq+\n6rV9mwCEvQpauQ2QNjy4TiwhqzqNiOPwpM3qo+8+3Ld+DUhzZzSzyx894dmJGlWQ\nwNss9Vs5/gnuvn6PurNXC42wkxY6Dmsnp/M6g08iqGXVcM6ZWmvCZ3BzBvwExxRR\n09KxHZVhwoMcF5Kp9l/hNZqXRgYMn3GLt+m78Hr+ZUjHiF8K9UH2TPxKRa/4ttPX\n6nDBZxZUCwFD7Zh6RePg07JDbO5fI/UYrqZYyDPK8w9xdXtke9LbdXmMuuk/x57h\nfoRArUkhPvUk/77mxo4++3EFnTUxYMnQVuMkDaYNRu7w83abUuhsjNlL/es24HSm\nlwIDAQAB\n-----END PUBLIC KEY-----`;

    this.verifier = new PluginVerifier(officialKey);

    this.verifier.loadKeysFromDirectory(keysDir);
    this.pluginDir = path.join(app.getPath('userData'), 'plugins');
    this.tempDir = path.join(app.getPath('temp'), 'trem-plugins');
    this.plugins = new Map();
    this.loadOrder = [];
    this.tremVersion = app.getVersion();
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

      if (!info || !info.name) {
        logger.error(`${infoPath} -> Plugin info.json must contain a name field`);
        return null;
      }

      const isValidName = /^[a-zA-Z-_]+$/.test(info.name);

      if (!isValidName) {
        logger.error(`Plugin name "${info.name}" is invalid. Only English letters, hyphens and underscores are allowed`);
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
      logger.error(`${infoPath} -> Failed to read plugin info:`, error);
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

  getFileMD5s(dirPath) {
    const md5Map = new Map();

    const processDirectory = (currentPath, relativePath = '') => {
      const files = fs.readdirSync(currentPath);

      for (const file of files) {
        const fullPath = path.join(currentPath, file);
        const relativeFilePath = relativePath ? path.join(relativePath, file) : file;

        if (fs.statSync(fullPath).isDirectory()) {
          processDirectory(fullPath, relativeFilePath);
        }
        else {
          md5Map.set(relativeFilePath, this.calculateMD5(fullPath));
        }
      }
    };

    processDirectory(dirPath);
    return md5Map;
  }

  async cleanupOrphanedPlugins() {
    logger.debug('Cleaning up orphaned plugin data...');

    const pluginFiles = fs.readdirSync(this.pluginDir);

    const validPluginNames = new Set();

    for (const file of pluginFiles) {
      const filePath = path.join(this.pluginDir, file);
      const stats = fs.statSync(filePath);

      if (stats.isDirectory()) {
        const infoPath = path.join(filePath, 'info.json');
        if (fs.existsSync(infoPath)) {
          try {
            const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
            if (info?.name) {
              validPluginNames.add(info.name);
            }
          }
          catch (error) {
            logger.error(`Error parsing info.json in ${file}:`, error);
          }
        }
      }
      else if (file.endsWith('.trem')) {
        try {
          const tempExtractPath = path.join(this.tempDir, '_temp_extract');
          if (fs.existsSync(tempExtractPath)) {
            await fs.remove(tempExtractPath);
          }

          const zip = new AdmZip(filePath);
          zip.extractAllTo(tempExtractPath, true);

          const infoPath = path.join(tempExtractPath, 'info.json');
          if (fs.existsSync(infoPath)) {
            const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
            if (info?.name) {
              validPluginNames.add(info.name);
            }
          }

          await fs.remove(tempExtractPath);
        }
        catch (error) {
          logger.error(`Error processing .trem file ${file}:`, error);
        }
      }
    }

    const tempFiles = fs.readdirSync(this.tempDir);

    for (const file of tempFiles) {
      if (file === '_temp_extract' || file.endsWith('_temp')) {
        continue;
      }

      const tempPath = path.join(this.tempDir, file);
      if (fs.statSync(tempPath).isDirectory()) {
        if (!validPluginNames.has(file)) {
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

    for (const file of files) {
      try {
        const filePath = path.join(this.pluginDir, file);
        const stats = fs.statSync(filePath);

        if (stats.isDirectory()) {
          const infoPath = path.join(filePath, 'info.json');
          if (fs.existsSync(infoPath)) {
            const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
            if (info?.name) {
              pluginPaths.set(info.name, {
                path: filePath,
                type: 'directory',
                info,
              });
            }
          }
        }
        else if (file.endsWith('.trem')) {
          const uniqueTempDir = path.join(
            this.tempDir,
            `_temp_extract_${file}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          );

          try {
            if (fs.existsSync(uniqueTempDir)) {
              await fs.remove(uniqueTempDir);
            }

            await fs.ensureDir(uniqueTempDir);

            const zip = new AdmZip(filePath);
            zip.extractAllTo(uniqueTempDir, true);

            const infoPath = path.join(uniqueTempDir, 'info.json');
            if (fs.existsSync(infoPath)) {
              const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
              if (info?.name && !pluginPaths.has(info.name)) {
                pluginPaths.set(info.name, {
                  path: filePath,
                  type: 'trem',
                  info,
                });
              }
            }
          }
          catch (error) {
            logger.error(`Error processing ${file} in temp dir ${uniqueTempDir}:`, error);
          }
          finally {
            try {
              if (fs.existsSync(uniqueTempDir)) {
                await fs.remove(uniqueTempDir);
                if (fs.existsSync(uniqueTempDir)) {
                  logger.warn(`Failed to remove temp directory: ${uniqueTempDir}`);
                }
              }
            }
            catch (cleanupError) {
              logger.error(`Error cleaning up temp directory ${uniqueTempDir}:`, cleanupError);
            }
          }
        }
      }
      catch (error) {
        logger.error(`Error processing ${file}:`, error);
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
            logger.error(`Error removing leftover temp directory ${tempPath}:`, error);
          }
        }
      }
    }
    catch (error) {
      logger.error('Error cleaning up temp directories:', error);
    }

    const allPlugins = new Map();

    for (const [pluginName, pathInfo] of pluginPaths) {
      if (processedPlugins.has(pluginName)) {
        continue;
      }

      try {
        const { path: sourcePath, type, info } = pathInfo;
        const targetPath = path.join(this.tempDir, pluginName);
        let needUpdate = false;
        let fileMD5s = new Map();

        if (type === 'directory') {
          const signaturePath = path.join(sourcePath, 'signature.json');
          const sourceFileMD5s = this.getFileMD5s(sourcePath);

          if (fs.existsSync(signaturePath)) {
            const signatures = JSON.parse(fs.readFileSync(signaturePath, 'utf8'));
            needUpdate = Object.entries(signatures).some(([file, md5]) =>
              sourceFileMD5s.get(file) !== md5,
            );
            fileMD5s = new Map(Object.entries(signatures));
          }
          else {
            if (fs.existsSync(targetPath)) {
              const tempFileMD5s = this.getFileMD5s(targetPath);
              needUpdate = Array.from(sourceFileMD5s.entries()).some(([file, md5]) =>
                tempFileMD5s.get(file) !== md5,
              );
            }
            else {
              needUpdate = true;
            }
            fileMD5s = sourceFileMD5s;
          }

          if (needUpdate) {
            if (fs.existsSync(targetPath)) {
              await fs.remove(targetPath);
            }
            await fs.ensureDir(targetPath);

            const copyFiles = async (dir, baseTarget, baseSource) => {
              const items = await fs.readdir(dir);
              for (const item of items) {
                const sourceFull = path.join(dir, item);
                const targetFull = path.join(baseTarget, path.relative(baseSource, sourceFull));
                const stat = await fs.stat(sourceFull);

                if (stat.isDirectory()) {
                  await fs.ensureDir(targetFull);
                  await copyFiles(sourceFull, baseTarget, baseSource);
                }
                else {
                  await fs.copyFile(sourceFull, targetFull);
                }
              }
            };

            await copyFiles(sourcePath, targetPath, sourcePath);

            const verification = this.verifier.verify(targetPath);

            const pluginInfo = this.readPluginInfo(targetPath);

            this.createTremInfoFile(targetPath, {
              md5s: Object.fromEntries(fileMD5s),
              lastUpdated: Date.now(),
              verification,
              pluginInfo,
            });
          }
        }
        else if (type === 'trem') {
          const tremInfo = this.readTremInfoFile(targetPath);
          const currentMD5 = this.calculateMD5(sourcePath);

          needUpdate = !tremInfo || !tremInfo.tremMD5
          || tremInfo.tremMD5 !== currentMD5
          || !fs.existsSync(targetPath);

          if (needUpdate) {
            await this.extractTremPlugin(sourcePath);
          }
        }

        const tremInfo = this.readTremInfoFile(targetPath);
        const verified = tremInfo.verification?.valid || false;
        if (!verified) {
          logger.warn('【!!!嚴重警告!!!】未發現有效簽名，除非信任擴充來源否則應立即停用 ->', pluginName);
          logger.warn('【!!!WARNING!!!】No valid signature found, disable immediately unless plugin source is trusted ->', pluginName);
        }
        if (fs.existsSync(targetPath) && tremInfo) {
          const pluginData = {
            name: pluginName,
            version: info.version,
            description: info.description,
            author: info.author,
            verified,
            verifyError: tremInfo.verification?.error || null,
            keyId: tremInfo.verification?.keyId || null,
            ctxDependencies: tremInfo.pluginInfo?.ctxDependencies || [],
            sensitivity: tremInfo.pluginInfo?.sensitivity || { level: 0, description: '未分析' },
            path: targetPath,
            originalPath: sourcePath,
            info: tremInfo.pluginInfo || info,
            dependencies: info.dependencies || {},
            type,
            lastUpdated: tremInfo.lastUpdated || Date.now(),
          };

          if (!tremInfo.pluginInfo) {
            logger.error(`Plugin ${pluginName} fails to load, please contact the plugin developer!`);
            fs.removeSync(targetPath);
          }
          else {
            allPlugins.set(pluginName, pluginData);
          }

          processedPlugins.add(pluginName);
        }
      }
      catch (error) {
        logger.error(`Error processing plugin ${pluginName}:`, error);
      }
    }

    localStorage.setItem('plugin-list', JSON.stringify(Array.from(allPlugins.values())));
    return allPlugins;
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
    this.plugins.clear();
    this.loadOrder = [];

    const enabledPlugins = JSON.parse(localStorage.getItem('enabled-plugins') || '[]');
    const scannedPlugins = await this.scanPlugins();

    for (const [name, pluginData] of scannedPlugins.entries()) {
      const isValidPlugin
      = pluginData.info?.['auto-enable'] == true
      && pluginData.info?.author.includes('ExpTech')
      && pluginData.verified == true;
      if (isValidPlugin) {
        manager.enable(pluginData.name);
      }
      if (enabledPlugins.includes(name) || isValidPlugin) {
        if (!pluginData.verified) {
          logger.debug(`Loading unverified plugin ${name}: ${pluginData.verifyError}`);
        }
        this.plugins.set(name, pluginData);
      }
      else if (!enabledPlugins.includes(name)) {
        logger.warn(`--- Plugin ${name} disable ---`);
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
          this.ctx.info.pluginDir = path.join(this.tempDir, pluginName);

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

const pluginLoader = new PluginLoader();

pluginLoader.loadPlugins();
pluginLoader.cleanupOrphanedPlugins();

module.exports = {
  default: PluginLoader,
  pluginLoader,
};
