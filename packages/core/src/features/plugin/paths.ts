/**
 * A POSIX `path` for the plugin sandbox.
 *
 * Plugins call `path.join(ctx.info.pluginDir, 'config.yml')` and hand the
 * result straight back to `fs.readFileSync`. The host answers those calls from
 * an in-memory tree rather than the real disk, so the paths are the host's own:
 * a virtual, always-POSIX root (`/plugins/<name>`). A plugin that hardcoded a
 * Windows separator still works — a backslash is treated as one here, which is
 * also what lets a plugin written on Windows load on macOS.
 */

const SEP = "/";

export const sep = SEP;
export const delimiter = ":";

export function normalize(input: string): string {
  if (!input) return ".";
  const text = input.replace(/\\/g, SEP);
  const absolute = text.startsWith(SEP);
  const trailing = text.length > 1 && text.endsWith(SEP);
  const parts: string[] = [];
  for (const part of text.split(SEP)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      const last = parts[parts.length - 1];
      if (parts.length > 0 && last !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(part);
  }
  let out = parts.join(SEP);
  if (absolute) out = SEP + out;
  if (!out) out = absolute ? SEP : ".";
  else if (trailing) out += SEP;
  return out;
}

export function isAbsolute(input: string): boolean {
  return input.startsWith(SEP) || input.startsWith("\\");
}

export function join(...parts: string[]): string {
  const joined = parts.filter((p) => p && p.length > 0).join(SEP);
  return joined ? normalize(joined) : ".";
}

export function resolve(...parts: string[]): string {
  let resolved = "";
  let absolute = false;
  for (let i = parts.length - 1; i >= 0 && !absolute; i--) {
    const part = parts[i];
    if (!part) continue;
    resolved = `${part}${SEP}${resolved}`;
    absolute = isAbsolute(part);
  }
  if (!absolute) resolved = `${SEP}${resolved}`;
  const normalized = normalize(resolved);
  return normalized.length > 1 && normalized.endsWith(SEP) ? normalized.slice(0, -1) : normalized;
}

function stripTrailing(input: string): string {
  let out = input;
  while (out.length > 1 && out.endsWith(SEP)) out = out.slice(0, -1);
  return out;
}

export function dirname(input: string): string {
  if (!input) return ".";
  const path = stripTrailing(input.replace(/\\/g, SEP));
  const at = path.lastIndexOf(SEP);
  if (at === -1) return ".";
  if (at === 0) return SEP;
  return path.slice(0, at);
}

export function basename(input: string, ext?: string): string {
  const path = stripTrailing(input.replace(/\\/g, SEP));
  const at = path.lastIndexOf(SEP);
  const base = at === -1 ? path : path.slice(at + 1);
  if (ext && base.endsWith(ext) && base !== ext) return base.slice(0, -ext.length);
  return base;
}

export function extname(input: string): string {
  const base = basename(input);
  const at = base.lastIndexOf(".");
  if (at <= 0) return "";
  return base.slice(at);
}

export interface ParsedPath {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
}

export function parse(input: string): ParsedPath {
  const root = isAbsolute(input) ? SEP : "";
  const dir = dirname(input);
  const base = basename(input);
  const ext = extname(base);
  return { root, dir: dir === "." && !root ? "" : dir, base, ext, name: base.slice(0, base.length - ext.length) };
}

export function format(pathObject: Partial<ParsedPath>): string {
  const dir = pathObject.dir || pathObject.root || "";
  const base = pathObject.base || `${pathObject.name ?? ""}${pathObject.ext ?? ""}`;
  return dir ? (dir === SEP ? `${SEP}${base}` : `${dir}${SEP}${base}`) : base;
}

/** `from` → `to`, both absolute: the `../` a plugin would need to write. */
export function relative(from: string, to: string): string {
  const a = resolve(from).split(SEP).filter(Boolean);
  const b = resolve(to).split(SEP).filter(Boolean);
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  const up = a.slice(shared).map(() => "..");
  return [...up, ...b.slice(shared)].join(SEP);
}

export function toNamespacedPath(input: string): string {
  return input;
}

export interface PathModule {
  sep: string;
  delimiter: string;
  normalize(input: string): string;
  isAbsolute(input: string): boolean;
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  dirname(input: string): string;
  basename(input: string, ext?: string): string;
  extname(input: string): string;
  parse(input: string): ParsedPath;
  format(pathObject: Partial<ParsedPath>): string;
  relative(from: string, to: string): string;
  toNamespacedPath(input: string): string;
  /** Set below: the sandbox has one flavour of path, so both point here. */
  posix?: PathModule;
  win32?: PathModule;
}

/** The whole module, for `ctx.utils.path` and `require('path')`. */
export const path: PathModule = {
  sep,
  delimiter,
  normalize,
  isAbsolute,
  join,
  resolve,
  dirname,
  basename,
  extname,
  parse,
  format,
  relative,
  toNamespacedPath,
};

path.posix = path;
path.win32 = path;
