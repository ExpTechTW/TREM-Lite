/**
 * `MixinManager`, ported from `legacy/src/js/core/mixin.js`.
 *
 * Injection here is textual, not a wrapper call: the handler's *body* is
 * spliced into the method's source and the whole method is rebuilt with
 * `Function(...params, body)`. A handler therefore runs inside the method's own
 * scope and can read its parameters and locals. That is what plugins were
 * written against, so it is what the port does — and why `tauri.conf.json`
 * keeps `"security": { "csp": null }`: a CSP without `unsafe-eval` would break
 * every mixin.
 *
 * The public shape is a class of statics because V3 handed plugins the class.
 */

type Handler = (...args: unknown[]) => unknown;

interface Injection {
  id: symbol;
  handler: Handler;
  position: "start" | "end" | number;
}

/** Anything with a prototype whose method can be rebuilt. */
type Target = { prototype: Record<string, unknown> };

/** The body between the outermost braces, trimmed — the part that is spliced. */
function handlerBody(handler: Handler): string {
  const text = handler.toString();
  return text.slice(text.indexOf("{") + 1, text.lastIndexOf("}")).trim();
}

export class MixinManager {
  private static mixins = new Map<string, Injection[]>();
  private static cache = new Map<string, string>();
  private static lineInjections = new Map<string, Map<number, Injection[]>>();
  private static targetClasses = new Map<string, Target>();

  static inject(target: Target, methodName: string, handler: Handler, position: Injection["position"] = "end"): symbol {
    if (typeof handler !== "function") throw new Error("Handler must be a function");

    const injection: Injection = { id: Symbol("mixin"), handler, position };
    MixinManager.initializeMethod(target, methodName);
    MixinManager.targetClasses.set(methodName, target);

    if (typeof position === "number") {
      if (!MixinManager.lineInjections.has(methodName)) MixinManager.lineInjections.set(methodName, new Map());
      const byLine = MixinManager.lineInjections.get(methodName)!;
      if (!byLine.has(position)) byLine.set(position, []);
      byLine.get(position)!.push(injection);
    } else {
      MixinManager.mixins.get(methodName)!.push(injection);
    }

    MixinManager.rebuild(MixinManager.targetClasses.get(methodName)!, methodName);
    MixinManager.cache.delete(methodName);
    return injection.id;
  }

  static remove(methodName: string, mixinId: symbol): boolean {
    let removed = false;
    const target = MixinManager.targetClasses.get(methodName);

    const mixins = MixinManager.mixins.get(methodName);
    const index = mixins?.findIndex((m) => m.id === mixinId) ?? -1;
    if (index !== -1) {
      mixins!.splice(index, 1);
      removed = true;
    }

    for (const injections of MixinManager.lineInjections.get(methodName)?.values() ?? []) {
      const at = injections.findIndex((m) => m.id === mixinId);
      if (at !== -1) {
        injections.splice(at, 1);
        removed = true;
      }
    }

    if (removed && target) {
      MixinManager.cache.delete(methodName);
      MixinManager.rebuild(target, methodName);
    }
    return removed;
  }

  static getMixins(methodName: string): { id: symbol; methodName: string }[] {
    return (MixinManager.mixins.get(methodName) ?? []).map(({ id }) => ({ id, methodName }));
  }

  static clear(methodName: string): void {
    MixinManager.mixins.delete(methodName);
    MixinManager.lineInjections.delete(methodName);
    MixinManager.cache.delete(methodName);
  }

  private static initializeMethod(target: Target, methodName: string): void {
    if (!MixinManager.mixins.has(methodName)) {
      MixinManager.mixins.set(methodName, []);
      MixinManager.rebuild(target, methodName);
    }
  }

  /**
   * Rebuild `targetClass.prototype[methodName]` with every injection spliced in.
   *
   * A method written as a class shorthand, an arrow property or a bound
   * function cannot be rebuilt this way — `toString()` of the first is
   * `methodName() { … }`, which has no `function` keyword, and the others have
   * no braces at all. Those throw here, and the plugin that asked for the
   * injection is told so rather than silently doing nothing.
   */
  private static rebuild(target: Target, methodName: string): void {
    const original = target.prototype[methodName];
    if (typeof original !== "function") {
      throw new Error(`MixinManager: ${methodName} is not a function`);
    }

    const source = original.toString();
    const open = source.indexOf("(");
    const close = source.indexOf(")");
    const braceStart = source.indexOf("{");
    const braceEnd = source.lastIndexOf("}");
    if (open === -1 || close === -1 || braceStart === -1 || braceEnd === -1) {
      throw new Error(`MixinManager: cannot read the source of ${methodName}`);
    }

    const params = source
      .slice(open + 1, close)
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const isAsync = source.includes("async");

    let lines = source
      .slice(braceStart + 1, braceEnd)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const injections = MixinManager.mixins.get(methodName) ?? [];

    const start = injections
      .filter((m) => m.position === "start")
      .map(({ handler }) => handlerBody(handler))
      .join("\n");
    if (start) lines.unshift(start);

    lines = lines.map((line, index) => {
      const at = MixinManager.lineInjections.get(methodName)?.get(index + 1) ?? [];
      const injected = at.map(({ handler }) => handlerBody(handler)).join("\n");
      return `${injected}\n${line}`;
    });

    const end = injections
      .filter((m) => m.position === "end")
      .map(({ handler }) => handlerBody(handler))
      .join("\n");
    if (end) lines.push(end);

    const body = lines.join("\n");
    const wrapped = `return ${isAsync ? "async " : ""}function ${methodName}() {\n${body}\n}`;
     
    target.prototype[methodName] = new Function(...params, wrapped)();
  }
}
