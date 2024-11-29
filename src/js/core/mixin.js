/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-extraneous-class */
class MixinManager {
  static mixins = new Map();
  static cache = new Map();
  static lineInjections = new Map();
  static targetClasses = new Map();

  static inject(targetClass, methodName, handler, position = 'end') {
    if (typeof handler !== 'function') {
      throw new Error('Handler must be a function');
    }

    const injection = {
      id: Symbol('mixin'),
      handler,
      position,
    };

    this._initializeMethod(targetClass, methodName);
    this.targetClasses.set(methodName, targetClass);

    if (typeof position === 'number') {
      if (!this.lineInjections.has(methodName)) {
        this.lineInjections.set(methodName, new Map());
      }
      const lineMap = this.lineInjections.get(methodName);
      if (!lineMap.has(position)) {
        lineMap.set(position, []);
      }
      lineMap.get(position).push(injection);
    }
    else {
      this.mixins.get(methodName).push(injection);
    }

    this._rebuildMethod(this.targetClasses.get(methodName), methodName);
    this.cache.delete(methodName);
    return injection.id;
  }

  static remove(methodName, mixinId) {
    let removed = false;
    const targetClass = this.targetClasses.get(methodName);

    const mixins = this.mixins.get(methodName);
    if (mixins) {
      const index = mixins.findIndex((m) => m.id === mixinId);
      if (index !== -1) {
        mixins.splice(index, 1);
        removed = true;
      }
    }

    const lineMap = this.lineInjections.get(methodName);
    if (lineMap) {
      for (const [_, injections] of lineMap) {
        const index = injections.findIndex((m) => m.id === mixinId);
        if (index !== -1) {
          injections.splice(index, 1);
          removed = true;
        }
      }
    }

    if (removed) {
      this.cache.delete(methodName);
      this._rebuildMethod(targetClass, methodName);
    }
    return removed;
  }

  static getMixins(methodName) {
    const mixins = this.mixins.get(methodName);
    if (!mixins) {
      return [];
    }
    return mixins.map(({ id }) => ({ id, methodName }));
  }

  static clear(methodName) {
    this.mixins.delete(methodName);
    this.lineInjections.delete(methodName);
    this.cache.delete(methodName);
  }

  static _initializeMethod(targetClass, methodName) {
    if (!this.mixins.has(methodName)) {
      this.mixins.set(methodName, []);
      this._rebuildMethod(targetClass, methodName);
    }
  }

  static _rebuildMethod(targetClass, methodName) {
    const original = targetClass.prototype[methodName];
    const fnStr = original.toString();

    const bodyStart = fnStr.indexOf('{') + 1;
    const bodyEnd = fnStr.lastIndexOf('}');
    const params = fnStr.slice(fnStr.indexOf('(') + 1, fnStr.indexOf(')')).split(',').map((p) => p.trim());
    const isAsync = fnStr.includes('async');

    let lines = fnStr.slice(bodyStart, bodyEnd)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const startInjections = this.mixins.get(methodName)
      .filter((m) => m.position === 'start')
      .map(({ handler }) => handler.toString()
        .slice(handler.toString().indexOf('{') + 1, handler.toString().lastIndexOf('}'))
        .trim())
      .join('\n');

    if (startInjections) {
      lines.unshift(startInjections);
    }

    lines = lines.map((line, index) => {
      const lineInjections = this.lineInjections.get(methodName)?.get(index + 1) || [];
      const injectedCode = lineInjections
        .map(({ handler }) => handler.toString()
          .slice(handler.toString().indexOf('{') + 1, handler.toString().lastIndexOf('}'))
          .trim())
        .join('\n');
      return injectedCode + '\n' + line;
    });

    const endInjections = this.mixins.get(methodName)
      .filter((m) => m.position === 'end')
      .map(({ handler }) => handler.toString()
        .slice(handler.toString().indexOf('{') + 1, handler.toString().lastIndexOf('}'))
        .trim())
      .join('\n');

    if (endInjections) {
      lines.push(endInjections);
    }

    const newFnBody = lines.join('\n');

    const wrappedFn = `
      return ${isAsync ? 'async ' : ''}function ${methodName}() {
        ${newFnBody}
      }
    `;

    targetClass.prototype[methodName] = Function(...params, wrappedFn)();
  }
}

module.exports = MixinManager;
