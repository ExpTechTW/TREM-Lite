/**
 * The extension contract, carried over from the Electron build
 * (`legacy/src/js/core/plugin.js`) so extensions written for TREM-Lite 3 keep
 * working. Field names, status strings and both loader styles are the published
 * V3 format: changing any of them would break every plugin already in the wild,
 * so this file describes what exists rather than what would be tidier.
 */

/**
 * V3 manifests ship text either as a plain string or as a table of locales —
 * the published plugins carry `description: { "zh_tw": …, "zh-Hant": … }`.
 */
export type LocalizedText = string | Record<string, string>;

/** `info.json` — the manifest every plugin ships. */
export interface PluginInfo {
  name: string;
  version: string;
  description?: LocalizedText;
  /** A string, or a list of them: the store lists authors as an array. */
  author?: LocalizedText | LocalizedText[];
  /** Which host this plugin runs in; `index` is the main window. */
  loader?: string[];
  /** Enable on first sight. Honoured only for a verified ExpTechTW plugin. */
  "auto-enable"?: boolean;
  /** `trem` is the host's version; every other key is another plugin's name. */
  dependencies?: Record<string, string>;
  /** What the plugin touches, as declared by its author. */
  sensitivity?: { level?: number; description?: LocalizedText };
  /** Licence identifiers, as the plugin store lists them. */
  resources?: string[];
  /** The plugin's home page, as the plugin store lists it. */
  link?: string;
  [key: string]: unknown;
}

/** This locale's wording, out of whatever shape the manifest used. */
export function localizedText(value: LocalizedText | undefined): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (!value) return undefined;
  for (const key of ["zh-Hant", "zh_tw", "zh-TW", "zh-Hans", "zh_cn", "en", "en-US"]) {
    const text = value[key];
    if (typeof text === "string" && text) return text;
  }
  return Object.values(value).find((text) => typeof text === "string" && text) || undefined;
}

/** The authors, however the manifest spelled them. */
export function authorNames(value: LocalizedText | LocalizedText[] | undefined): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => localizedText(item)).filter((name): name is string => Boolean(name));
}

/** `signature.json` — written by `tool/plugin/sign.mjs`. */
export interface PluginSignature {
  /** Relative POSIX path → SHA-256 hex of the LF-normalised text. */
  fileHashes: Record<string, string>;
  /** RSA-SHA256 over `JSON.stringify(fileHashes)`, base64. */
  signature: string;
  /** A key in `<app_config_dir>/plugin-keys`; `official` or absent = ExpTech. */
  keyId?: string;
}

/** One file as Rust hands it over: base64, because assets are not text. */
export interface PluginFile {
  path: string;
  data: string;
}

/** One installed plugin directory, as returned by `plugin_list`. */
export interface PluginDir {
  name: string;
  files: PluginFile[];
}

/** A trusted signing key, from `plugin_keys`. */
export interface PluginKey {
  id: string;
  pem: string;
}

export interface VerifyResult {
  valid: boolean;
  error?: string;
  keyId?: string;
}

/** What went wrong with one plugin, shown in the 擴充 page. */
export interface PluginStatus {
  type: "ok" | "warn" | "error";
  msg: string;
}

/** One row of the 擴充 page. */
export interface PluginEntry {
  name: string;
  info: PluginInfo;
  /** The directory still exists on disk (false = installed but deleted). */
  present: boolean;
  /** `signature.json` is absent, or does not match the files. */
  verified: boolean;
  /** Why verification failed, verbatim as V3 reported it. */
  verifyError?: string;
  keyId?: string;
  enabled: boolean;
  /** The plugin's code ran without throwing. */
  loaded: boolean;
  status: PluginStatus | null;
  sensitivity: { level: number; description: string };
  /** The plugin ships a `config.yml` (V3 offered a YAML editor for it). */
  hasConfig: boolean;
}

/** The shape persisted under `loaded-plugins`, read by tooling and V3 alike. */
export interface LoadedPlugin {
  name: string;
  version: string;
  description?: LocalizedText;
  author?: LocalizedText | LocalizedText[];
  ctxDependencies: string[];
  sensitivity: { level: number; description: string };
}
