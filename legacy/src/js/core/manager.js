const manager = new class Manager {
  constructor() {
    if (!Manager.instance) {
      this.enabledPlugins = new Set(JSON.parse(localStorage.getItem('enabled-plugins') || '[]'));
      Manager.instance = this;
    }
    return Manager.instance;
  }

  enable(pluginName) {
    if (this.enabledPlugins.has(pluginName)) {
      return false;
    }
    this.enabledPlugins.add(pluginName);
    this._save();
    return true;
  }

  disable(pluginName) {
    const result = this.enabledPlugins.delete(pluginName);
    if (result) {
      this._save();
    }
    return result;
  }

  isEnabled(pluginName) {
    return this.enabledPlugins.has(pluginName);
  }

  getEnabled() {
    return Array.from(this.enabledPlugins);
  }

  _save() {
    localStorage.setItem('enabled-plugins', JSON.stringify(Array.from(this.enabledPlugins)));
  }
}();

module.exports = manager;
