const MixinManager = {
  mixins: new Map(),
  cache: new Map(),

  inject(targetClass, methodName, handler, priority = 0) {
    if (typeof handler !== 'function') {
      throw new Error('Handler must be a function');
    }

    this._initializeMethod(targetClass, methodName);

    const id = Symbol('mixin');
    this.mixins.get(methodName).push({ id, priority, handler });
    this.cache.delete(methodName);

    return id;
  },

  batchInject(targetClass, injections) {
    const ids = {};
    for (const [methodName, handler, priority] of injections) {
      ids[methodName] = this.inject(targetClass, methodName, handler, priority);
    }

    return ids;
  },

  remove(methodName, mixinId) {
    const mixins = this.mixins.get(methodName);
    if (!mixins) {
      return false;
    }

    const index = mixins.findIndex((m) => m.id === mixinId);
    if (index === -1) {
      return false;
    }

    mixins.splice(index, 1);
    this.cache.delete(methodName);
    return true;
  },

  getSortedHandlers(methodName) {
    if (this.cache.has(methodName)) {
      return this.cache.get(methodName);
    }

    const sorted = [...this.mixins.get(methodName)]
      .sort((a, b) => b.priority - a.priority);

    this.cache.set(methodName, sorted);
    return sorted;
  },

  getMixins(methodName) {
    const mixins = this.mixins.get(methodName);
    if (!mixins) {
      return [];
    }

    return mixins.map(({ priority, id }) => ({
      id,
      priority,
      methodName,
    }));
  },

  clear(methodName) {
    this.mixins.delete(methodName);
    this.cache.delete(methodName);
  },

  _initializeMethod(targetClass, methodName) {
    if (!this.mixins.has(methodName)) {
      this.mixins.set(methodName, []);
      const original = targetClass.prototype[methodName];

      if (typeof original !== 'function') {
        throw new Error(`Method ${methodName} does not exist on target class`);
      }

      targetClass.prototype[methodName] = function (...args) {
        let method = original.bind(this);

        const sortedMixins = MixinManager.getSortedHandlers(methodName);

        method = sortedMixins.reduceRight((prev, { handler }) => (...params) => handler.call(this, prev, ...params), method);

        return method(...args);
      };
    }
  },
};

Object.freeze(MixinManager);

module.exports = MixinManager;
