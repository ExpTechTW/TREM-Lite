/**
 * The plugin sandbox: one in-memory file tree and the `fs`, `path` and
 * `require` a plugin is handed.
 *
 * V3 plugins ran in Electron's renderer, where `fs.readFileSync` was
 * synchronous and the whole disk was theirs. A synchronous read cannot cross an
 * async IPC boundary, so the host instead reads every installed plugin up front
 * (one `plugin_list` call), serves reads from memory, and forwards writes to
 * Rust one file at a time. Plugins see a virtual POSIX tree rooted at
 * `/plugins`, mirroring the real directory — the same layout
 * `ctx.info.pluginDir` pointed at in V3.
 *
 * Deliberately absent: any path outside `/plugins`, `child_process` and npm
 * packages. A plugin that reaches for one gets a named error rather than a
 * confusing `undefined` — and a *bare* specifier is not a package but another
 * extension's folder, which is what makes `require("other-plugin")` work.
 * `electron` is not absent: `ipcRenderer` is what every
 * extension that has a window of its own starts with, and `electron.ts` answers
 * it with the host's own windows.
 */
import { encodeBase64, type Bytes } from "./base64";
import { electronModule } from "./electron";
import { dirname, isAbsolute, join, normalize, path as pathsModule, resolve, type PathModule } from "./paths";

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

/** The virtual root every plugin is mounted under. */
export const PLUGIN_ROOT = "/plugins";

/** A Node `Buffer`, enough of one: `toString` is what plugins actually call. */
export class PluginBuffer extends Uint8Array {
  toString(encoding = "utf8"): string {
    switch (encoding) {
      case "utf8":
      case "utf-8":
        return decoder.decode(this);
      case "base64":
        return encodeBase64(this);
      case "hex":
        return [...this].map((b) => b.toString(16).padStart(2, "0")).join("");
      case "latin1":
      case "binary":
        return String.fromCharCode(...this);
      case "ascii":
        return decoder.decode(this);
      default:
        throw new Error(`不支援的編碼：${encoding}`);
    }
  }

  static isBuffer(value: unknown): boolean {
    return value instanceof Uint8Array;
  }

  static alloc(size: number): PluginBuffer {
    return new PluginBuffer(size);
  }

  static concat(list: Uint8Array[]): PluginBuffer {
    const total = list.reduce((sum, part) => sum + part.length, 0);
    const out = new PluginBuffer(total);
    let at = 0;
    for (const part of list) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  static from(...args: unknown[]): PluginBuffer {
    const [value] = args;
    if (typeof value === "string") return new PluginBuffer(encoder.encode(value));
    if (value instanceof Uint8Array) return new PluginBuffer(value);
    return new PluginBuffer(0);
  }
}

/** What `statSync` returns: the handful of fields plugins look at. */
export class PluginStats {
  constructor(
    private readonly dir: boolean,
    private readonly file: boolean,
    readonly size: number,
    readonly mtimeMs = Date.now(),
  ) {}

  isDirectory(): boolean {
    return this.dir;
  }

  isFile(): boolean {
    return this.file;
  }

  isSymbolicLink(): boolean {
    return false;
  }

  isBlockDevice(): boolean {
    return false;
  }

  isCharacterDevice(): boolean {
    return false;
  }

  isFIFO(): boolean {
    return false;
  }

  isSocket(): boolean {
    return false;
  }

  get mtime(): Date {
    return new Date(this.mtimeMs);
  }

  get ctime(): Date {
    return new Date(this.mtimeMs);
  }

  get birthtime(): Date {
    return new Date(this.mtimeMs);
  }
}

interface Dirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** An `Error` shaped like Node's, because plugins check `.code`. */
function fsError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function toBytes(data: unknown): Uint8Array {
  if (typeof data === "string") return encoder.encode(data);
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError("fs: 資料必須是字串或 Uint8Array");
}

/**
 * Every installed plugin, mounted at `/plugins/<name>`.
 *
 * One tree rather than one per plugin, because `ctx.require('../other/x.js')`
 * was how V3 plugins reached each other, and a bare `require` would have to
 * cross the same boundary anyway.
 */
export class PluginTree {
  private files = new Map<string, Uint8Array>();
  private dirs = new Set<string>([PLUGIN_ROOT]);

  mount(name: string, files: Map<string, Uint8Array>): void {
    const root = join(PLUGIN_ROOT, name);
    this.dirs.add(root);
    for (const [relative, bytes] of files) {
      this.write(join(root, relative), bytes);
    }
  }

  has(path: string): boolean {
    return this.files.has(normalize(path));
  }

  read(path: string): Uint8Array | undefined {
    return this.files.get(normalize(path));
  }

  isDirectory(path: string): boolean {
    const key = normalize(path);
    if (this.dirs.has(key)) return true;
    return this.children(key).length > 0;
  }

  write(path: string, bytes: Uint8Array): void {
    const key = normalize(path);
    this.files.set(key, bytes);
    this.dirs.add(dirname(key));
  }

  delete(path: string): boolean {
    const key = normalize(path);
    let removed = this.files.delete(key);
    for (const file of [...this.files.keys()]) {
      if (file.startsWith(`${key}/`)) {
        this.files.delete(file);
        removed = true;
      }
    }
    for (const dir of [...this.dirs]) {
      if (dir === key || dir.startsWith(`${key}/`)) {
        this.dirs.delete(dir);
        removed = true;
      }
    }
    return removed;
  }

  /** Every entry directly under `path`, in the order a directory lists them. */
  children(path: string): Dirent[] {
    const key = normalize(path);
    const prefix = key === "/" ? "/" : `${key}/`;
    const seen = new Map<string, Dirent>();
    const add = (absolute: string, isDir: boolean) => {
      const rest = absolute.slice(prefix.length);
      if (!rest || rest.includes("/")) return;
      const existing = seen.get(rest);
      if (existing) {
        if (isDir) seen.set(rest, dirent(rest, true, false));
        return;
      }
      seen.set(rest, dirent(rest, isDir, !isDir));
    };
    for (const file of this.files.keys()) if (file.startsWith(prefix)) add(file, false);
    for (const dir of this.dirs) if (dir.startsWith(prefix)) add(dir, true);
    return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Relative POSIX path → bytes, for the verifier. */
  snapshot(root: string): Map<string, Uint8Array> {
    const key = normalize(root);
    const prefix = `${key}/`;
    const out = new Map<string, Uint8Array>();
    for (const [file, bytes] of this.files) {
      if (file.startsWith(prefix)) out.set(file.slice(prefix.length), bytes);
    }
    return out;
  }
}

function dirent(name: string, isDir: boolean, isFile: boolean): Dirent {
  return { name, isDirectory: () => isDir, isFile: () => isFile };
}

export interface RuntimeOptions {
  plugin: string;
  tree: PluginTree;
  /** A file the plugin wrote — `null` when it was deleted. Relative path. */
  onWrite(path: string, data: Uint8Array | null): void;
  log: {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  /**
   * The plugin's own directory. Relative paths resolve here and `process.cwd()`
   * reports it — `ctx.info.pluginDir` stays the *root*, as it was in V3.
   */
  pluginDir?: string;
  /**
   * The runtime of another plugin, for `require("<plugin-name>")`.
   *
   * A module has to be evaluated by the runtime that owns its folder: `fs`
   * resolves relative paths against `pluginDir` and writes are attributed to
   * `plugin`, so evaluating one plugin's file with another's runtime would
   * hand it the wrong directory. The loader answers this from the plugins it
   * has running, which is also why a plugin reached by name must be enabled.
   */
  lookup?: (plugin: string) => PluginRuntime | undefined;
}

/**
 * Everything a plugin sees of its host: `fs`, `path`, `require`, a `Buffer`, a
 * minimal `process`, and the entry loader that evaluates `index.js`.
 */
export class PluginRuntime {
  readonly path: PathModule;
  readonly fs: Record<string, unknown>;
  readonly pluginDir: string;
  readonly Buffer = PluginBuffer;

  private modules = new Map<string, { exports: Record<string, unknown> }>();
  private tree: PluginTree;

  constructor(private readonly options: RuntimeOptions) {
    this.tree = options.tree;
    // V3's `info.pluginDir` was the *root* of the plugins directory, not the
    // plugin's own folder; plugins joined their name onto it. That stays true
    // for `ctx.info`, but a *relative* path should mean "next to my own files",
    // not "at the root beside my siblings".
    this.pluginDir = options.pluginDir ?? PLUGIN_ROOT;
    this.path = pathsModule;
    this.fs = this.buildFs();
  }

  // -- paths ---------------------------------------------------------------

  /** A plugin-relative or absolute path as an absolute virtual path. */
  toVirtual(input: string): string {
    if (isAbsolute(input)) return normalize(input);
    return resolve(this.pluginDir, input);
  }

  /** The plugin this path belongs to, for a cross-plugin write refusal. */
  private ownName(path: string): string {
    return normalize(path).slice(PLUGIN_ROOT.length + 1).split("/")[0] ?? "";
  }

  /** A virtual path as the plugin's own relative path, for Rust. */
  private relativeToPlugin(path: string): string {
    return normalize(path).slice(`${join(PLUGIN_ROOT, this.options.plugin)}/`.length);
  }

  // -- fs ------------------------------------------------------------------

  private buildFs(): Record<string, unknown> {
    const fs: Record<string, unknown> = {};
    const read = (p: string): Uint8Array => {
      const bytes = this.tree.read(this.toVirtual(p));
      if (!bytes) throw fsError("ENOENT", `ENOENT: no such file or directory, open '${p}'`);
      return bytes;
    };

    fs.readFileSync = (p: string, options?: string | { encoding?: string | null } | null) => {
      const bytes = read(p);
      const encoding = typeof options === "string" ? options : options?.encoding;
      if (!encoding) return new PluginBuffer(bytes);
      return new PluginBuffer(bytes).toString(encoding);
    };

    fs.writeFileSync = (p: string, data: unknown) => {
      const target = this.toVirtual(p);
      const owner = this.ownName(target);
      if (owner !== this.options.plugin) {
        // V3's fs could write anywhere; the tree holds only plugins, so the
        // only meaningful refusal left is writing into another plugin.
        throw fsError("EACCES", `EACCES: 擴充功能只能寫入自己的資料夾，'${p}'`);
      }
      const bytes = toBytes(data);
      this.tree.write(target, bytes);
      this.options.onWrite(this.relativeToPlugin(target), bytes);
    };

    fs.appendFileSync = (p: string, data: unknown) => {
      const existing = this.tree.read(this.toVirtual(p));
      const addition = toBytes(data);
      const merged = new Uint8Array((existing?.length ?? 0) + addition.length);
      if (existing) merged.set(existing, 0);
      merged.set(addition, existing?.length ?? 0);
      (fs.writeFileSync as (p: string, data: unknown) => void)(p, merged);
    };

    fs.existsSync = (p: string): boolean => {
      const key = this.toVirtual(p);
      return this.tree.has(key) || this.tree.isDirectory(key);
    };

    fs.statSync = (p: string): PluginStats => {
      const key = this.toVirtual(p);
      const bytes = this.tree.read(key);
      if (bytes) return new PluginStats(false, true, bytes.length);
      if (this.tree.isDirectory(key)) return new PluginStats(true, false, 0);
      throw fsError("ENOENT", `ENOENT: no such file or directory, stat '${p}'`);
    };

    fs.lstatSync = fs.statSync;

    fs.readdirSync = (p: string, options?: { withFileTypes?: boolean } | string): unknown[] => {
      const key = this.toVirtual(p);
      if (!this.tree.isDirectory(key)) {
        throw fsError("ENOENT", `ENOENT: no such file or directory, scandir '${p}'`);
      }
      const entries = this.tree.children(key);
      if (options && typeof options === "object" && options.withFileTypes) return entries;
      return entries.map((entry) => entry.name);
    };

    fs.mkdirSync = () => undefined; // directories exist because files do
    fs.ensureDirSync = () => undefined;
    fs.mkdirpSync = () => undefined;

    fs.unlinkSync = (p: string) => {
      const target = this.toVirtual(p);
      if (!this.tree.delete(target)) {
        throw fsError("ENOENT", `ENOENT: no such file or directory, unlink '${p}'`);
      }
      this.options.onWrite(this.relativeToPlugin(target), null);
    };
    fs.rmdirSync = fs.unlinkSync;
    fs.rmSync = fs.unlinkSync;
    fs.removeSync = fs.unlinkSync;

    fs.copyFileSync = (from: string, to: string) => {
      (fs.writeFileSync as (p: string, data: unknown) => void)(to, read(from));
    };

    fs.renameSync = (from: string, to: string) => {
      const bytes = read(from);
      (fs.writeFileSync as (p: string, data: unknown) => void)(to, bytes);
      (fs.unlinkSync as (p: string) => void)(from);
    };

    fs.realpathSync = (p: string) => this.toVirtual(p);

    // Callback forms, for plugins that used them.
    const callbackify =
      (sync: (...args: never[]) => unknown) =>
      (...args: unknown[]) => {
        const callback = args.pop() as ((error: unknown, value?: unknown) => void) | undefined;
        try {
          const value = (sync as (...a: unknown[]) => unknown)(...args);
          callback?.(null, value);
        } catch (error) {
          callback?.(error);
        }
      };
    fs.readFile = callbackify(fs.readFileSync as (...args: never[]) => unknown);
    fs.writeFile = callbackify(fs.writeFileSync as (...args: never[]) => unknown);
    fs.stat = callbackify(fs.statSync as (...args: never[]) => unknown);
    fs.readdir = callbackify(fs.readdirSync as (...args: never[]) => unknown);

    fs.promises = {
      readFile: (p: string, o?: unknown) => Promise.resolve(fs.readFileSync && (fs.readFileSync as (p: string, o?: unknown) => unknown)(p, o)),
      writeFile: (p: string, d: unknown) => Promise.resolve((fs.writeFileSync as (p: string, d: unknown) => void)(p, d)),
      stat: (p: string) => Promise.resolve((fs.statSync as (p: string) => PluginStats)(p)),
      readdir: (p: string) => Promise.resolve((fs.readdirSync as (p: string) => unknown[])(p)),
      unlink: (p: string) => Promise.resolve((fs.unlinkSync as (p: string) => void)(p)),
      mkdir: () => Promise.resolve(),
      access: (p: string) => Promise.resolve((fs.existsSync as (p: string) => boolean)(p)),
    };

    // fs-extra, which the V3 settings and plugins both used.
    fs.readJsonSync = (p: string, options?: { encoding?: string }) => {
      const text = (fs.readFileSync as (p: string, o?: unknown) => string)(p, options ?? "utf8");
      return JSON.parse(text) as unknown;
    };
    fs.writeJsonSync = (p: string, value: unknown, options?: { spaces?: number }) => {
      (fs.writeFileSync as (p: string, d: unknown) => void)(p, JSON.stringify(value, null, options?.spaces ?? 2));
    };
    fs.outputJsonSync = fs.writeJsonSync;
    fs.readJSONSync = fs.readJsonSync;
    fs.writeJSONSync = fs.writeJsonSync;

    fs.watch = () => ({ close: () => undefined });
    fs.createReadStream = () => {
      throw new Error("擴充功能不支援 fs.createReadStream，請改用 fs.readFileSync。");
    };
    fs.createWriteStream = () => {
      throw new Error("擴充功能不支援 fs.createWriteStream，請改用 fs.writeFileSync。");
    };

    fs.constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };
    fs.exists = (p: string, callback: (exists: boolean) => void) => callback((fs.existsSync as (p: string) => boolean)(p));
    return fs;
  }

  // -- require -------------------------------------------------------------

  /** Evaluate a module by specifier, relative to the file that asked. */
  require(specifier: string, from: string): unknown {
    const name = specifier.replace(/^node:/, "");

    if (name in BUILTINS) return this.builtin(name);
    if (name in UNSUPPORTED) throw new Error(UNSUPPORTED[name]);

    if (!isAbsolute(specifier) && !specifier.startsWith(".")) {
      // One extension standing on another: the tree holds every installed
      // plugin, so a bare name is that plugin's own folder. `dependencies`
      // already ordered the two, and asking for an absent one happens when a
      // plugin reaches for a package, so say both halves.
      if (this.isBareName(specifier)) {
        const root = join(PLUGIN_ROOT, specifier);
        if (this.tree.isDirectory(root)) {
          // `index.js`, because that is the file the host loads as the plugin
          // itself — anything else would hand the asker a module the host never
          // treated as that plugin.
          return this.evaluate(`${root}/index.js`);
        }
      }
      throw new Error(`Cannot find module '${specifier}'：擴充功能不能載入 npm 套件，請改用相對路徑，或另一個擴充功能的名稱。`);
    }

    const base = isAbsolute(specifier) ? normalize(specifier) : resolve(dirname(from), specifier);
    for (const candidate of [base, `${base}.js`, `${base}.cjs`, `${base}.json`, `${join(base, "index.js")}`, `${join(base, "index.json")}`]) {
      if (this.tree.has(candidate)) return this.evaluate(candidate);
    }
    throw new Error(`Cannot find module '${specifier}' from ${from}`);
  }

  /** A plugin name is a bare specifier only if it could name a directory. */
  private isBareName(specifier: string): boolean {
    return /^[a-z0-9][a-z0-9-]*$/.test(specifier);
  }

  private evaluate(file: string): unknown {
    // A file in another plugin's folder — reached by name, or by the
    // `../other-plugin/util` path V3 documented — has to run under *its* owner's
    // runtime. Otherwise the `fs` inside it resolves relative paths against the
    // plugin that happened to ask, and a write would be attributed there too.
    // No owner means nothing loaded that plugin yet, which is a message about
    // `dependencies`, not a missing file: the folder is right there.
    const owner = this.ownName(file);
    if (owner !== this.options.plugin) {
      const other = this.options.lookup?.(owner);
      if (!other) {
        throw new Error(`擴充功能「${owner}」尚未載入，請在 info.json 的 dependencies 加入 ${owner}，讓它先載入。`);
      }
      return other.evaluate(file);
    }

    const cached = this.modules.get(file);
    if (cached) return cached.exports;

    const bytes = this.tree.read(file);
    if (!bytes) throw new Error(`Cannot find module '${file}'`);
    const source = decoder.decode(bytes);
    const dir = dirname(file);
    const module = { exports: {} as Record<string, unknown> };
    this.modules.set(file, module);

    if (file.endsWith(".json")) {
      module.exports = JSON.parse(source) as Record<string, unknown>;
      return module.exports;
    }

    const require = (specifier: string) => this.require(specifier, file);
    // The wrapper is what makes a CommonJS plugin run: `require`, `module`,
    // `__filename` and `__dirname` as globals inside the file's own scope.
    // `sourceURL` puts the plugin's own name in a stack trace.
     
    const factory = new Function(
      "exports",
      "require",
      "module",
      "__filename",
      "__dirname",
      "Buffer",
      "process",
      "console",
      "global",
      `${source}\n//# sourceURL=plugin://${this.options.plugin}${file}`,
    ) as (...args: unknown[]) => void;

    factory(
      module.exports,
      require,
      module,
      file,
      dir,
      PluginBuffer,
      this.processShim(),
      this.consoleShim(),
      globalThis,
    );
    return module.exports;
  }

  /** Evaluate the plugin's entry file and return what it exported. */
  loadEntry(entry = "index.js"): unknown {
    return this.evaluate(join(PLUGIN_ROOT, this.options.plugin, entry));
  }

  /** `ctx.require`, which V3 implemented as `require` with path juggling. */
  ctxRequire(modulePath: string, from: string): unknown {
    // `from` is the plugin's own *directory*. `require` resolves a relative
    // specifier against the directory of the file that asked, so name a file
    // inside it — otherwise `./lib/x` would look beside the plugin, not in it.
    return this.require(modulePath, `${from}/index.js`);
  }

  // -- small builtins ------------------------------------------------------

  private builtin(name: string): unknown {
    switch (name) {
      case "path":
        return this.path;
      case "fs":
      case "fs-extra":
      case "fs-extra/esm":
        return this.fs;
      case "buffer":
        return { Buffer: PluginBuffer };
      case "process":
        return this.processShim();
      case "events":
        return { EventEmitter: EventEmitter, default: EventEmitter };
      case "util":
        return utilShim;
      case "os":
        return osShim;
      case "url":
        return { URL, URLSearchParams, pathToFileURL, fileURLToPath, default: { URL, URLSearchParams } };
      case "crypto":
        return cryptoShim;
      case "electron":
        return electronModule(this.options.plugin);
      default:
        throw new Error(UNSUPPORTED[name] ?? `Cannot find module '${name}'`);
    }
  }

  private processShim() {
    const platform = navigator.platform.toLowerCase().includes("win")
      ? "win32"
      : navigator.platform.toLowerCase().includes("mac")
        ? "darwin"
        : "linux";
    return {
      platform,
      arch: "x64",
      version: "v22.0.0",
      versions: { node: "22.0.0", electron: undefined },
      env: {} as Record<string, string>,
      argv: ["trem-lite"],
      pid: 0,
      cwd: () => this.pluginDir,
      chdir: () => undefined,
      nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
      on: () => undefined,
      exit: () => {
        throw new Error("擴充功能不能結束主程式。");
      },
    };
  }

  private consoleShim() {
    const { log } = this.options;
    return {
      log: (...args: unknown[]) => log.info(...args),
      info: (...args: unknown[]) => log.info(...args),
      warn: (...args: unknown[]) => log.warn(...args),
      error: (...args: unknown[]) => log.error(...args),
      debug: (...args: unknown[]) => log.debug(...args),
      trace: (...args: unknown[]) => log.debug(...args),
      table: (...args: unknown[]) => log.info(...args),
    };
  }
}

/** The built-in modules `require` answers without touching the tree. */
const BUILTINS: Record<string, true> = {
  path: true,
  fs: true,
  "fs-extra": true,
  "fs-extra/esm": true,
  buffer: true,
  process: true,
  events: true,
  util: true,
  os: true,
  url: true,
  crypto: true,
  electron: true,
};

/** Named refusals: a plugin that needs one of these needs a different host. */
const UNSUPPORTED: Record<string, string> = {
  "@electron/remote": "擴充功能不能用 remote 取得主視窗，請改用 ctx.TREM。",
  child_process: "擴充功能不能啟動其他程式。",
  "node:child_process": "擴充功能不能啟動其他程式。",
  worker_threads: "擴充功能不能建立 worker。",
  net: "擴充功能不能直接開 socket，請改用 ctx.TREM.constant.URL 與 fetch。",
  http: "擴充功能不能直接開 socket，請改用 fetch。",
  https: "擴充功能不能直接開 socket，請改用 fetch。",
  axios: "擴充功能不能載入 npm 套件，請改用 fetch。",
};

/** Node's `EventEmitter`, enough of one for the events plugins subscribe to. */
export class EventEmitter {
  private handlers = new Map<string | symbol, ((...args: unknown[]) => void)[]>();

  on(event: string | symbol, handler: (...args: unknown[]) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }

  addListener(event: string | symbol, handler: (...args: unknown[]) => void): this {
    return this.on(event, handler);
  }

  once(event: string | symbol, handler: (...args: unknown[]) => void): this {
    const wrapped = (...args: unknown[]) => {
      this.off(event, wrapped);
      handler(...args);
    };
    return this.on(event, wrapped);
  }

  off(event: string | symbol, handler: (...args: unknown[]) => void): this {
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter((h) => h !== handler));
    return this;
  }

  removeListener(event: string | symbol, handler: (...args: unknown[]) => void): this {
    return this.off(event, handler);
  }

  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) this.handlers.clear();
    else this.handlers.delete(event);
    return this;
  }

  listeners(event: string | symbol): ((...args: unknown[]) => void)[] {
    return [...(this.handlers.get(event) ?? [])];
  }

  listenerCount(event: string | symbol): number {
    return this.handlers.get(event)?.length ?? 0;
  }

  setMaxListeners(): this {
    return this;
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    const handlers = this.handlers.get(event) ?? [];
    for (const handler of [...handlers]) handler(...args);
    return handlers.length > 0;
  }
}

const utilShim = {
  format: (template: unknown, ...args: unknown[]): string => {
    let index = 0;
    return String(template).replace(/%[sdifjoO%]/g, (match) => {
      if (match === "%%") return "%";
      const value = args[index++];
      if (match === "%j") {
        try {
          return JSON.stringify(value);
        } catch {
          return "[Circular]";
        }
      }
      return typeof value === "string" ? value : inspect(value);
    });
  },
  inspect,
  promisify:
    (fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      new Promise((done, fail) => {
        fn(...args, (error: unknown, value: unknown) => (error ? fail(error) : done(value)));
      }),
  types: { isDate: (v: unknown) => v instanceof Date, isRegExp: (v: unknown) => v instanceof RegExp },
  inherits: () => undefined,
  deprecate: <T>(fn: T): T => fn,
};

function inspect(value: unknown, depth = 2): string {
  if (typeof value === "string") return `'${value}'`;
  if (value instanceof Error) return value.stack ?? value.message;
  if (value === null || typeof value !== "object") return String(value);
  if (depth <= 0) return "[Object]";
  if (Array.isArray(value)) return `[ ${value.map((v) => inspect(v, depth - 1)).join(", ")} ]`;
  return `{ ${Object.entries(value)
    .map(([k, v]) => `${k}: ${inspect(v, depth - 1)}`)
    .join(", ")} }`;
}

const osShim = {
  platform: (): string =>
    navigator.platform.toLowerCase().includes("win") ? "win32" : navigator.platform.toLowerCase().includes("mac") ? "darwin" : "linux",
  arch: (): string => "x64",
  type: (): string => "TREM-Lite",
  release: (): string => navigator.userAgent,
  hostname: (): string => location.hostname || "localhost",
  tmpdir: (): string => PLUGIN_ROOT,
  homedir: (): string => PLUGIN_ROOT,
  EOL: "\n",
  cpus: (): { model: string }[] => [{ model: "unknown" }],
  totalmem: (): number => 0,
  freemem: (): number => 0,
  uptime: (): number => performance.now() / 1000,
  userInfo: () => ({ username: "trem" }),
};

const cryptoShim = {
  getRandomValues: <T extends ArrayBufferView<ArrayBuffer>>(array: T): T => crypto.getRandomValues(array),
  randomUUID: (): string => crypto.randomUUID(),
  randomBytes: (size: number): PluginBuffer => {
    const bytes = new PluginBuffer(size);
    crypto.getRandomValues(bytes as Bytes);
    return bytes;
  },
  subtle: crypto.subtle,
  createHash: () => {
    // WebCrypto's digest is async only, and a plugin's call site is not.
    throw new Error("擴充功能不支援 crypto.createHash，請改用 crypto.subtle.digest。");
  },
};

function pathToFileURL(file: string): URL {
  return new URL(`file://${file}`);
}

function fileURLToPath(url: URL | string): string {
  const text = typeof url === "string" ? url : url.href;
  return decodeURIComponent(text.replace(/^file:\/\//, ""));
}
