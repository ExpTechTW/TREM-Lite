/**
 * The extension host: scanning, verification, dependency order and loading.
 *
 * This is `legacy/src/js/core/plugin.js`'s `PluginLoader` rebuilt for V4. The
 * parts that a plugin can observe are kept deliberately identical — the `ctx`
 * it receives, the `info.json` contract, the dependency rules, the status
 * strings, the localStorage key — because extensions already exist that depend
 * on them. The parts it cannot observe are new: files live in one tree that was
 * read in a single call, verification is WebCrypto, and every plugin runs in a
 * CommonJS sandbox rather than in Electron's main world.
 *
 * Load order, verbatim from V3: scan → auto-enable → dependency order → start.
 */
import { getVersion } from "@tauri-apps/api/app";
import maplibregl from "maplibre-gl";

import { events } from "@/lib/events";
import { createLogger } from "@/lib/logger";
import type { TremEvents } from "@/lib/types";

import { decodeBase64 } from "./base64";
import {
  discardPackage,
  installPlugin,
  pluginKeys,
  pluginPackages,
  pluginRoot,
  pluginStorageAvailable,
  readPlugins,
  removePlugin,
  writePluginFile,
} from "./bridge";
import { NAME_PATTERN, parsePackage } from "./package";
import { MixinManager } from "./mixin";
import { PLUGIN_ROOT, PluginRuntime, PluginTree } from "./sandbox";
import { tremGlobal } from "./trem";
import { authorNames, localizedText } from "./types";
import type { LoadedPlugin, PluginEntry, PluginFile, PluginInfo, PluginStatus } from "./types";
import { getVersionPrefixString, validateVersionRequirement } from "./version";
import { verifyPlugin as verify } from "./verify";

const log = createLogger("plugin");

/** V3's key. A plugin enabled in the Electron build stays enabled here. */
const ENABLED_KEY = "enabled-plugins";
/** What this host loaded, in V3's shape, for tooling that reads it. */
const LOADED_KEY = "loaded-plugins";
/** What the last load decided about each one — the key V3's 擴充 page read. */
const STATUS_KEY = "plugin-status";

/** V3's wording, kept verbatim: the 擴充 page greps for it. */
const STATUS_INIT_FAILED = "初始化失敗，請聯繫擴充作者。";
const STATUS_DISABLED = "未啟用。";
/** The 擴充 page records the choice; the main window loads it at the next boot. */
const STATUS_RESTART = "將於下次啟動時載入。";

/**
 * Turn a failure into something the 擴充 page can show next to the plugin.
 *
 * V3 said "contact the author" and left it there; the author cannot act on that
 * sentence alone. The reason is either ours (`不能使用 Electron API`) or the
 * plugin's own, and it is what the plugin's author needs to be told — kept to
 * one line, because the row has one.
 */
function failureReason(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).split("\n")[0]?.trim() ?? "";
  if (!text) return "";
  return `（${text.length > 120 ? `${text.slice(0, 119)}…` : text}）`;
}

export function getSensitivityDescription(level: number): string {
  switch (level) {
    case 4:
      return "極高敏感度 - 包含系統核心API存取權限";
    case 3:
      return "高敏感度 - 包含注入或檔案系統存取權限";
    case 2:
      return "中等敏感度 - 包含事件權限";
    case 1:
      return "低敏感度 - 包含日誌/元數據存取權限";
    default:
      return "無敏感操作";
  }
}

type PluginHandler = (...args: never[]) => unknown;
type PluginLogger = ReturnType<typeof createLogger>;

/** The object handed to a plugin's entry point. This is V3's `ctx`, field for field. */
export interface PluginContext {
  TREM: ReturnType<typeof tremGlobal>;
  events: typeof events;
  logger: PluginLogger;
  Logger: {
    getLogger(scope: string): PluginLogger;
    getInstance(): PluginLogger;
  };
  MixinManager: typeof MixinManager;
  maplibregl: typeof maplibregl;
  info: {
    /** The plugins *root*, as in V3 — not the plugin's own folder. */
    pluginDir: string;
    originalPath: string;
    /** V4 addition: the plugin's own name, so a path needs no guessing. */
    name: string;
  };
  utils: { path: unknown; fs: unknown };
  on(event: string, handler: PluginHandler): void;
  require(modulePath: string): unknown;
}

interface RunningPlugin {
  runtime: PluginRuntime;
  /** Handlers registered through `ctx.on`, unbound ones included. */
  handlers: Array<{ event: string; handler: PluginHandler }>;
}

interface InstallOptions {
  /** Replacing a plugin that is already running. */
  replace?: boolean;
}

/**
 * 設定 → 擴充 is a second webview. It lists, verifies, installs and removes; the
 * plugins themselves belong to the main window, where the map and the data feed
 * are. `management` is how that window keeps this one from starting anything.
 */
export interface LoaderOptions {
  management?: boolean;
}

export class PluginLoader {
  private readonly type: string;
  /** Built by 設定 → 擴充: read, verify and record, but never run. */
  private readonly management: boolean;
  /** Rows the 擴充 page shows, keyed by plugin name. */
  private entries = new Map<string, PluginEntry>();
  private running = new Map<string, RunningPlugin>();
  private trees = new Map<string, Map<string, Uint8Array>>();
  private keys = new Map<string, string>();
  /**
   * What the main window's last load concluded, read from `plugin-status`.
   *
   * Empty in the main window, which knows the answer first hand.
   */
  private reported: Record<string, PluginStatus> = {};
  private listeners = new Set<() => void>();
  private started = false;
  /** The app's own version, as `dependencies.trem` is compared against. */
  tremVersion = "";
  /**
   * `<app_config_dir>/plugins` — where the tree on disk actually is.
   *
   * Empty until `scan()` has asked: `/plugins` is the sandbox's name for the
   * same place, not a path anything outside the plugin runtime can open.
   */
  rootPath = "";

  constructor(type = "index", options: LoaderOptions = {}) {
    this.type = type;
    this.management = options.management ?? false;
  }

  // -- reading -------------------------------------------------------------

  list(): PluginEntry[] {
    return [...this.entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  get(name: string): PluginEntry | undefined {
    return this.entries.get(name);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  /** V3's `getLoadedPlugins()`, in the shape it persisted under `loaded-plugins`. */
  getLoadedPlugins(): LoadedPlugin[] {
    return this.list()
      .filter((entry) => entry.loaded)
      .map((entry) => ({
        name: entry.name,
        version: entry.info.version ?? "",
        description: entry.info.description,
        author: entry.info.author,
        ctxDependencies: (entry.info.dependencies?.ctx as string[] | undefined) ?? [],
        sensitivity: entry.sensitivity,
      }));
  }

  // -- scanning ------------------------------------------------------------

  /**
   * Read every plugin directory and verify each one.
   *
   * The whole tree arrives in one `plugin_list` call, which is what makes the
   * synchronous `fs` a plugin was written against possible: `PluginTree` is
   * that call's result, kept in memory.
   */
  async scan(): Promise<void> {
    if (!pluginStorageAvailable) {
      log.info("瀏覽器模式：擴充功能無法使用。");
      return;
    }
    this.tremVersion = await getVersion();
    this.rootPath = await pluginRoot();
    this.trees = await readPlugins();
    this.keys = new Map((await pluginKeys()).map((key) => [key.id, key.pem]));
    this.reported = this.management ? this.readStatus() : {};

    for (const [name, files] of this.trees) {
      const entry = await this.inspect(name, files);
      if (entry) this.entries.set(name, entry);
    }
    // A plugin that was uninstalled since the last scan leaves no row behind.
    for (const name of [...this.entries.keys()]) {
      if (!this.trees.has(name)) this.entries.delete(name);
    }
    // Dependencies are checked once every manifest is in hand: a plugin may
    // depend on one that sorts after it. V3 only checked while loading, so the
    // row said nothing about a plugin until the next boot; checking here is
    // what lets 設定 → 擴充 answer "why can this one not run" straight away.
    for (const entry of this.entries.values()) this.validateDependencies(entry);
    this.changed();
  }

  private async inspect(name: string, files: Map<string, Uint8Array>): Promise<PluginEntry | null> {
    const manifest = files.get("info.json");
    if (!manifest) {
      log.warn(`略過 ${name}：缺少 info.json。`);
      return null;
    }

    let info: PluginInfo;
    try {
      info = JSON.parse(new TextDecoder().decode(manifest)) as PluginInfo;
    } catch (e) {
      log.warn(`略過 ${name}：info.json 不是合法的 JSON（${String(e)}）。`);
      return null;
    }
    if (!info.name || !NAME_PATTERN.test(info.name)) {
      log.warn(`略過 ${name}：info.json 的 name 不合格式（僅允許小寫字母、數字與連字號）。`);
      return null;
    }

    const verified = await verify(files, this.keys);
    const level = info.sensitivity?.level ?? 0;
    // The settings window runs no plugin of its own, so why one is not running
    // can only come from what the main window wrote under `plugin-status` —
    // which is exactly what V3's `setting/plugin_list.js` read it for. The
    // main window is the one that finds out first hand, so it ignores the key.
    const reported = this.reported[name];
    return {
      name: info.name,
      info,
      present: true,
      verified: verified.valid,
      verifyError: verified.error,
      keyId: verified.keyId,
      enabled: this.readEnabled().includes(name),
      loaded: this.management && this.readLoaded().includes(name),
      status: reported ?? (verified.valid ? null : { type: "warn", msg: verified.error ?? "未發現有效簽名。" }),
      sensitivity: {
        level,
        description: localizedText(info.sensitivity?.description) ?? getSensitivityDescription(level),
      },
      hasConfig: files.has("config.yml"),
    };
  }

  // -- enabling ------------------------------------------------------------

  private readEnabled(): string[] {
    try {
      const raw = JSON.parse(localStorage.getItem(ENABLED_KEY) ?? "[]") as unknown;
      return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }

  private writeEnabled(names: string[]): void {
    localStorage.setItem(ENABLED_KEY, JSON.stringify([...new Set(names)]));
  }

  /**
   * What the *main* window left behind under V3's `loaded-plugins` key.
   *
   * The settings window runs no plugin of its own, so 已載入 cannot come from
   * this process; it comes from that key — which is how V3's
   * `setting/plugin_list.js` learned it too.
   */
  private readLoaded(): string[] {
    try {
      const raw = JSON.parse(localStorage.getItem(LOADED_KEY) ?? "[]") as unknown;
      if (!Array.isArray(raw)) return [];
      return raw
        .map((item) => (item as LoadedPlugin | undefined)?.name)
        .filter((name): name is string => typeof name === "string");
    } catch {
      return [];
    }
  }

  isEnabled(name: string): boolean {
    return this.entries.get(name)?.enabled ?? false;
  }

  /** What the last load decided, in V3's shape, for the 擴充 page. */
  private readStatus(): Record<string, PluginStatus> {
    try {
      const raw = JSON.parse(localStorage.getItem(STATUS_KEY) ?? "{}") as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      return raw as Record<string, PluginStatus>;
    } catch {
      return {};
    }
  }

  /** Turn one plugin on and start it, or off and unhook it. */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) return;

    if (enabled) {
      this.writeEnabled([...this.readEnabled(), name]);
      entry.enabled = true;
      if (this.management) {
        entry.status = { type: "warn", msg: STATUS_RESTART };
      } else {
        await this.start(name);
      }
    } else {
      this.writeEnabled(this.readEnabled().filter((item) => item !== name));
      entry.enabled = false;
      this.stop(name);
      entry.status = { type: "warn", msg: STATUS_DISABLED };
    }
    this.persist();
    this.changed();
  }

  // -- loading -------------------------------------------------------------

  /**
   * The whole load, in V3's order.
   *
   * Auto-enable is deliberately narrow: `auto-enable` in the manifest, an
   * ExpTechTW author, **and** a valid signature. Two of the three would let an
   * unsigned plugin run by claiming the author's name.
   */
  async load(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await this.importPackages();
    await this.scan();
    const enabled = new Set(this.readEnabled());

    for (const entry of this.entries.values()) {
      const byExptech = authorNames(entry.info.author).some((name) => name.includes("ExpTechTW"));
      if (entry.info["auto-enable"] === true && byExptech && entry.verified) {
        enabled.add(entry.name);
      }
    }
    this.writeEnabled([...enabled]);

    for (const name of this.dependencyOrder([...enabled])) {
      const entry = this.entries.get(name);
      if (!entry) {
        log.warn(`略過 ${name}：找不到這個擴充功能。`);
        continue;
      }
      entry.enabled = true;
      await this.start(name);
    }

    for (const entry of this.entries.values()) {
      if (!entry.enabled) entry.status ??= { type: "warn", msg: STATUS_DISABLED };
    }
    this.persist();
    this.changed();
  }

  private async start(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry || entry.loaded) return;

    const files = this.trees.get(name);
    if (!files) {
      entry.status = { type: "error", msg: "找不到擴充功能的檔案。" };
      return;
    }
    if (!this.validateDependencies(entry)) return;

    // `loader` names the host windows a plugin runs in; only `index` exists.
    const loader = entry.info.loader ?? ["index"];
    if (!loader.includes(this.type)) {
      entry.status = { type: "warn", msg: STATUS_DISABLED };
      return;
    }

    const tree = new PluginTree();
    for (const [owned, ownedFiles] of this.trees) {
      tree.mount(owned, ownedFiles);
    }
    const runtime = new PluginRuntime({
      plugin: name,
      tree,
      pluginDir: `${PLUGIN_ROOT}/${name}`,
      // A plugin that `require`s another by name gets *that* plugin's runtime,
      // so the file it loads keeps its own folder and its own `fs`. Only
      // plugins already running answer, which is what `dependencyOrder` above
      // arranged; a name that is installed but disabled gets its own message
      // rather than a silent `undefined`.
      lookup: (other) => this.running.get(other)?.runtime,
      log: createLogger(`plugin:${name}`),
      onWrite: (path, data) => {
        void writePluginFile(name, path, data).catch((e: unknown) => {
          log.error(`寫入 ${name}/${path} 失敗：${String(e)}`);
        });
        const owned = this.trees.get(name);
        if (!owned) return;
        if (data === null) owned.delete(path);
        else owned.set(path, data);
      },
    });

    const handlers: Array<{ event: string; handler: PluginHandler }> = [];
    this.running.set(name, { runtime, handlers });
    const ok = await this.initialize(entry, runtime, handlers);
    if (!ok) this.running.delete(name);
  }

  private stop(name: string): void {
    const plugin = this.running.get(name);
    if (!plugin) return;
    for (const { event, handler } of plugin.handlers) {
      if (event === "load") continue;
      events.off(event as keyof TremEvents, handler as never);
    }
    this.running.delete(name);
    const entry = this.entries.get(name);
    if (entry) entry.loaded = false;
  }

  /** V3's `initializePlugin`: a class gets `onLoad`, a function gets `ctx.on('load')`. */
  private async initialize(
    entry: PluginEntry,
    runtime: PluginRuntime,
    handlers: Array<{ event: string; handler: PluginHandler }>,
  ): Promise<boolean> {
    const name = entry.name;
    try {
      const exported = runtime.loadEntry("index.js");
      const mod = exported as { default?: unknown } | null;
      const Plugin = (mod && typeof mod === "object" && "default" in mod ? mod.default : exported) as unknown;

      if (typeof Plugin !== "function") {
        throw new TypeError("index.js 沒有匯出擴充功能的進入點。");
      }
      const ctx = this.buildContext(name, runtime, handlers);

      if (Plugin.toString().startsWith("class")) {
        const instance = new (Plugin as new (ctx: PluginContext) => { onLoad?: () => unknown })(ctx);
        if (typeof instance?.onLoad === "function") await instance.onLoad();
      } else {
        (Plugin as (ctx: PluginContext) => void)(ctx);
        // A function-style plugin receives its `load` event after it returns.
        for (const { handler } of handlers.filter((item) => item.event === "load")) {
          handler();
        }
      }

      for (const { event, handler } of handlers) {
        if (event !== "load") events.on(event as keyof TremEvents, handler as never);
      }
      entry.loaded = true;
      entry.status = { type: "ok", msg: "已載入。" };
      log.info(`已載入擴充功能 ${name} ${entry.info.version ?? ""}`);
      return true;
    } catch (e) {
      log.error(`擴充功能 ${name} 初始化失敗：${String(e)}`);
      entry.loaded = false;
      entry.status = { type: "error", msg: `${STATUS_INIT_FAILED}${failureReason(e)}` };
      return false;
    }
  }

  private buildContext(
    name: string,
    runtime: PluginRuntime,
    handlers: Array<{ event: string; handler: PluginHandler }>,
  ): PluginContext {
    const pluginLog = createLogger(`plugin:${name}`);
    const ownDir = `${PLUGIN_ROOT}/${name}`;
    return {
      TREM: tremGlobal(),
      events,
      logger: pluginLog,
      Logger: {
        getLogger: (scope: string) => createLogger(`plugin:${name}:${scope}`),
        getInstance: () => pluginLog,
      },
      MixinManager,
      maplibregl,
      info: { pluginDir: PLUGIN_ROOT, originalPath: PLUGIN_ROOT, name },
      utils: { path: runtime.path, fs: runtime.fs },
      on: (event, handler) => {
        handlers.push({ event, handler });
      },
      require: (modulePath) => runtime.ctxRequire(modulePath, ownDir),
    };
  }

  // -- dependencies --------------------------------------------------------

  /**
   * V3's `validateDependencies`, messages included.
   *
   * `dependencies.trem` is the host's version; every other key names another
   * plugin, whose declared version must satisfy the requirement.
   */
  validateDependencies(entry: PluginEntry): boolean {
    const dependencies = entry.info.dependencies;
    if (!dependencies) return true;

    const { trem, ...plugins } = dependencies;
    if (trem && !validateVersionRequirement(this.tremVersion, trem)) {
      entry.status = {
        type: "error",
        msg: `需要 TREM-Lite 的版本為 ${getVersionPrefixString(trem)}，但目前安裝的版本為 ${this.tremVersion}。`,
      };
      return false;
    }

    for (const [dependency, requirement] of Object.entries(plugins)) {
      const target = this.entries.get(dependency);
      if (!target) {
        entry.status = { type: "error", msg: `缺少 ${dependency} 依賴。` };
        return false;
      }
      if (requirement && !validateVersionRequirement(target.info.version ?? "", requirement)) {
        entry.status = {
          type: "error",
          msg: `需要 ${dependency} 的版本為 ${getVersionPrefixString(requirement)}，但目前安裝的版本為 ${target.info.version}。`,
        };
        return false;
      }
    }
    return true;
  }

  /** A dependency-first order over the plugins being started, as V3 sorted them. */
  private dependencyOrder(names: string[]): string[] {
    const wanted = new Set(names);
    const seen = new Set<string>();
    const order: string[] = [];

    const visit = (name: string): void => {
      if (seen.has(name)) return;
      seen.add(name);
      const entry = this.entries.get(name);
      const dependencies = entry?.info.dependencies ?? {};
      for (const dependency of Object.keys(dependencies)) {
        if (dependency !== "trem" && wanted.has(dependency)) visit(dependency);
      }
      order.push(name);
    };

    for (const name of [...wanted].sort()) visit(name);
    return order;
  }

  // -- installing ----------------------------------------------------------

  /**
   * A `.trem` left in the plugin folder is an install waiting to happen.
   *
   * V3 shipped one that way — `index/plugin_init.js` copied a bundled package
   * into the folder at boot — and anyone who opens the folder and copies a file
   * into it expects the same. The archive is thrown away once it is in, so a
   * package that installs is only ever installed once; one that fails stays
   * where it is and says why in the log.
   */
  private async importPackages(): Promise<void> {
    if (!pluginStorageAvailable) return;

    let packages: PluginFile[];
    try {
      packages = await pluginPackages();
    } catch (e) {
      log.warn(`讀取擴充功能套件失敗：${String(e)}`);
      return;
    }

    for (const pkg of packages) {
      try {
        const name = await this.installPackage(decodeBase64(pkg.data));
        await discardPackage(pkg.path);
        log.info(`已安裝擴充功能資料夾中的 ${pkg.path}（${name}）。`);
      } catch (e) {
        log.warn(`安裝 ${pkg.path} 失敗：${String(e)}`);
      }
    }
  }

  /**
   * Install an unpacked plugin, replacing any previous copy.
   *
   * Replace, never merge: a file left over from the previous version would
   * still be hashed by the next verification and reported as an extra file.
   */
  async install(name: string, files: PluginFile[], options: InstallOptions = {}): Promise<void> {
    if (!NAME_PATTERN.test(name)) {
      throw new Error("擴充功能的名稱只能包含小寫字母、數字與連字號。");
    }
    if (this.running.has(name) && !options.replace) {
      throw new Error(`擴充功能 ${name} 正在執行，請先停用再安裝。`);
    }
    this.stop(name);
    await installPlugin(name, files);
    await this.scan();
  }

  /**
   * Install a `.trem` package — a zip of a plugin directory.
   *
   * The archive may wrap everything in a single top-level folder, which is what
   * most zips of a folder look like; that wrapper is stripped.
   */
  async installPackage(data: Uint8Array, name?: string): Promise<string> {
    const parsed = parsePackage(data);
    const plugin = name ?? parsed.name;
    if (!NAME_PATTERN.test(plugin)) {
      throw new Error("info.json 的 name 不合格式（僅允許小寫字母、數字與連字號）。");
    }
    await this.install(plugin, parsed.files, { replace: true });
    return plugin;
  }

  async remove(name: string): Promise<void> {
    this.stop(name);
    await removePlugin(name);
    this.writeEnabled(this.readEnabled().filter((item) => item !== name));
    this.entries.delete(name);
    this.trees.delete(name);
    this.persist();
    this.changed();
  }

  /** The plugin's `config.yml`, as text, or `null` when it ships none. */
  readConfig(name: string): string | null {
    const bytes = this.trees.get(name)?.get("config.yml");
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  async writeConfig(name: string, text: string): Promise<void> {
    const bytes = new TextEncoder().encode(text);
    await writePluginFile(name, "config.yml", bytes);
    this.trees.get(name)?.set("config.yml", bytes);
  }

  // -- persistence ---------------------------------------------------------

  /** Mirror V3's `loaded-plugins` and `plugin-status` keys. */
  private persist(): void {
    try {
      localStorage.setItem(LOADED_KEY, JSON.stringify(this.getLoadedPlugins()));
      const status: Record<string, PluginStatus> = {};
      for (const entry of this.entries.values()) {
        if (entry.status) status[entry.name] = entry.status;
      }
      localStorage.setItem(STATUS_KEY, JSON.stringify(status));
    } catch (e) {
      log.warn(`無法寫入擴充功能狀態：${String(e)}`);
    }
  }
}

/** One loader for the app, created on first use. */
let instance: PluginLoader | null = null;

export function createPluginLoader(type = "index", options: LoaderOptions = {}): PluginLoader {
  instance ??= new PluginLoader(type, options);
  return instance;
}

export function pluginLoader(): PluginLoader | null {
  return instance;
}
