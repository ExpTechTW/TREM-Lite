const TREM = require("../index/constant");
const logger = require("./utils/logger");
const { app } = require("@electron/remote");
const semver = require("semver");
const path = require("path");
const fs = require("fs");
const MixinManager = require("./mixin");

class PluginBase {
  constructor(_TREM) {
    this.TREM = _TREM;
  }

  onLoad() {void 0;}
  onUnload() {void 0;}
}

class PluginLoader {
  constructor() {
    this.pluginDir = path.join(app.getPath("userData"), "plugins");
    this.plugins = new Map();
    this.loadOrder = [];
    this.tremVersion = app.getVersion();

    this.ctx = {
      TREM,
      logger,
      utils: {
        path,
        fs,
        semver,
      },
    };
  }

  getVersionPriority(version) {
    if (!version) return 0;
    const parsed = semver.parse(version);
    if (!parsed) return 0;

    const prerelease = parsed.prerelease[0];
    if (!prerelease) return 3;
    if (prerelease === "rc") return 2;
    if (prerelease === "pre") return 1;
    return 0;
  }

  isExactVersionMatch(v1, v2) {
    const parsed1 = semver.parse(v1);
    const parsed2 = semver.parse(v2);

    if (!parsed1 || !parsed2) return false;

    if (parsed1.major !== parsed2.major ||
        parsed1.minor !== parsed2.minor ||
        parsed1.patch !== parsed2.patch)
      return false;

    const pre1 = parsed1.prerelease;
    const pre2 = parsed2.prerelease;

    if (pre1.length !== pre2.length) return false;
    if (pre1.length === 0) return true;
    return pre1[0] === pre2[0] && pre1[1] === pre2[1];
  }

  compareVersions(v1, v2) {
    const parsed1 = semver.parse(v1);
    const parsed2 = semver.parse(v2);

    if (!parsed1 || !parsed2) return false;

    if (parsed1.major !== parsed2.major)
      return parsed1.major >= parsed2.major;

    if (parsed1.minor !== parsed2.minor)
      return parsed1.minor >= parsed2.minor;

    if (parsed1.patch !== parsed2.patch)
      return parsed1.patch >= parsed2.patch;

    const priority1 = this.getVersionPriority(v1);
    const priority2 = this.getVersionPriority(v2);

    if (priority1 !== priority2)
      return priority1 >= priority2;

    if (parsed1.prerelease.length > 1 && parsed2.prerelease.length > 1)
      return parsed1.prerelease[1] >= parsed2.prerelease[1];

    return true;
  }

  validateVersionRequirement(current, required) {
    if (required.includes(" ")) {
      const ranges = required.split(" ");
      return ranges.every(range => this.validateVersionRequirement(current, range));
    }

    const operator = required.match(/^[>=<]+/)?.[0] || ">=";
    const reqVersion = required.replace(/^[>=<]+/, "");

    switch (operator) {
      case "=":
        return this.isExactVersionMatch(current, reqVersion);
      case ">=":
        return this.compareVersions(current, reqVersion);
      case ">":
        return this.compareVersions(current, reqVersion) && !this.isExactVersionMatch(current, reqVersion);
      case "<":
        return !this.compareVersions(current, reqVersion);
      case "<=":
        return !this.compareVersions(current, reqVersion) || this.isExactVersionMatch(current, reqVersion);
      default:
        return this.compareVersions(current, reqVersion);
    }
  }

  readPluginInfo(pluginPath) {
    const infoPath = path.join(pluginPath, "info.json");
    try {
      const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));

      if (!info.name) {
        logger.error(`(${infoPath}) -> Plugin info.json must contain a name field`);
        return null;
      }

      return info;
    } catch (error) {
      logger.error(`(${infoPath}) -> Failed to read plugin info:`, error);
      return null;
    }
  }

  validateDependencies(pluginInfo) {
    if (!pluginInfo.dependencies) return true;

    if (pluginInfo.dependencies.trem)
      if (!this.validateVersionRequirement(this.tremVersion, pluginInfo.dependencies.trem)) {
        logger.error(`Plugin ${pluginInfo.name} requires TREM version ${pluginInfo.dependencies.trem}, but ${this.tremVersion} is installed`);
        return false;
      }

    for (const [dep, version] of Object.entries(pluginInfo.dependencies)) {
      if (dep === "trem") continue;

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

  buildDependencyGraph() {
    const visited = new Set();
    const tempMark = new Set();
    this.loadOrder = [];

    const visit = (pluginName) => {
      if (tempMark.has(pluginName))
        throw new Error(`Circular dependency detected: ${pluginName}`);

      if (visited.has(pluginName)) return;

      tempMark.add(pluginName);
      const plugin = this.plugins.get(pluginName);

      if (plugin.dependencies)
        for (const dep of Object.keys(plugin.dependencies))
          if (dep !== "trem" && this.plugins.has(dep))
            visit(dep);

      tempMark.delete(pluginName);
      visited.add(pluginName);
      this.loadOrder.unshift(pluginName);
    };

    for (const pluginName of this.plugins.keys())
      if (!visited.has(pluginName))
        visit(pluginName);
  }

  async initializePlugin(pluginName, plugin, PluginClass) {
    try {
      const instance = new PluginClass(this.ctx);
      plugin.instance = instance;
      await instance.onLoad();
      logger.info(`Successfully loaded plugin: ${pluginName} (version ${plugin.info.version})`);
      return true;
    } catch (error) {
      logger.error(`Failed to initialize plugin ${pluginName}:`, error);
      return false;
    }
  }

  async loadPlugins() {
    logger.info(`Loading plugins (TREM version: ${this.tremVersion})`);

    if (!fs.existsSync(this.pluginDir)) {
      fs.mkdirSync(this.pluginDir, { recursive: true });
      return;
    }

    const directories = fs.readdirSync(this.pluginDir)
      .filter(file => fs.statSync(path.join(this.pluginDir, file)).isDirectory());

    for (const dir of directories) {
      const pluginPath = path.join(this.pluginDir, dir);
      const info = this.readPluginInfo(pluginPath);

      if (info)
        this.plugins.set(info.name, {
          path         : pluginPath,
          info,
          dependencies : info.dependencies || {},
        });

    }

    for (const [pluginName, plugin] of this.plugins.entries())
      if (!this.validateDependencies(plugin.info)) {
        this.plugins.delete(pluginName);
        logger.warn(`Skipping plugin ${pluginName} due to dependency issues`);
      }

    try {
      this.buildDependencyGraph();
    } catch (error) {
      logger.error("Failed to resolve plugin dependencies:", error);
      return;
    }

    for (const pluginName of this.loadOrder) {
      const plugin = this.plugins.get(pluginName);
      const indexPath = path.join(plugin.path, "index.js");

      try {
        if (fs.existsSync(indexPath)) {
          const PluginClass = require(indexPath);
          if (this.isValidPluginClass(PluginClass)) {
            const success = await this.initializePlugin(pluginName, plugin, PluginClass);
            if (!success)
              this.plugins.delete(pluginName);
          } else {
            logger.error(`Plugin ${pluginName} does not export a valid plugin class (must implement onLoad and onUnload methods)`);
            this.plugins.delete(pluginName);
          }
        }
      } catch (error) {
        logger.error(`Failed to load plugin ${pluginName}: ${error}`);
        this.plugins.delete(pluginName);
      }
    }
  }

  async unloadPlugin(pluginName) {
    const plugin = this.plugins.get(pluginName);
    if (plugin?.instance) {
      await plugin.instance.onUnload();
      this.plugins.delete(pluginName);
    }
  }

  getLoadedPlugins() {
    return Array.from(this.plugins.entries()).map(([name, plugin]) => ({
      name,
      version     : plugin.info.version,
      description : plugin.info.description,
      author      : plugin.info.author,
    }));
  }
}

const pluginLoader = new PluginLoader();
pluginLoader.loadPlugins();

module.exports = PluginLoader;