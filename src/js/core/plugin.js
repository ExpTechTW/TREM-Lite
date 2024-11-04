const TREM = require("../index/constant");
const MixinManager = require("../core/mixin");

const { app } = require("@electron/remote");

const path = require("path");
const fs = require("fs");

class PluginLoader {
  constructor() {
    this.pluginDir = path.join(app.getPath("userData"), "plugins");
    this.plugins = [];
  }

  loadPlugins() {
    const files = fs.readdirSync(this.pluginDir);

    files.forEach((file) => {
      const pluginPath = path.join(this.pluginDir, file);
      if (fs.lstatSync(pluginPath).isFile() && file.endsWith(".js"))
        try {
          const plugin = require(pluginPath);
          if (typeof plugin === "function") {
            plugin(TREM, MixinManager);
            this.plugins.push(pluginPath);
            console.log(`Plugin loaded: ${file}`);
          }
        } catch (error) {
          console.error(`Failed to load plugin ${file}:`, error);
        }

    });
  }
}
const pluginLoader = new PluginLoader();
pluginLoader.loadPlugins();

module.exports = PluginLoader;