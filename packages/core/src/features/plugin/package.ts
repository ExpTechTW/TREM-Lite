/**
 * Reading a `.trem` — a zip of a plugin directory.
 *
 * Zip entry names are supposed to be `/`-separated, but the archives Windows
 * itself produces — 「傳送到 → 壓縮的資料夾」 and PowerShell's `Compress-Archive` —
 * write `\`. Those install too, so names are normalised on the way in. The zip
 * may also wrap everything in one top-level folder, which is what zipping a
 * folder looks like; that wrapper is stripped here.
 *
 * Kept apart from `host.ts` so it can be tested: it touches no browser API and
 * no bridge, only the bytes.
 */
import { unzipSync } from "fflate";

import { encodeBase64 } from "./base64";
import type { PluginFile, PluginInfo } from "./types";

/** Re-exported for `tool/plugin/selftest.ts`, which lives outside the package. */
export { zipSync } from "fflate";

/** `info.json` names are lowercase, hyphenated, and nothing else. */
export const NAME_PATTERN = /^[a-z0-9-]+$/;

export interface ParsedPackage {
  /** The name from `info.json`, before any override. */
  name: string;
  info: PluginInfo;
  /** Every file, wrapper stripped, POSIX paths relative to the plugin folder. */
  files: PluginFile[];
}

/** Unpack a `.trem` into the files the host would write to disk. */
export function parsePackage(data: Uint8Array): ParsedPackage {
  const entries = Object.entries(unzipSync(data))
    .map(([entry, bytes]) => ({ path: entry.replace(/\\/g, "/").replace(/^\.\//, ""), bytes }))
    .filter(
      ({ path }) => path && !path.endsWith("/") && !path.startsWith("__MACOSX/") && !path.endsWith(".DS_Store"),
    );

  const manifest =
    entries.find(({ path }) => path === "info.json") ?? entries.find(({ path }) => path.endsWith("/info.json"));
  if (!manifest) throw new Error("套件裡找不到 info.json。");

  let info: PluginInfo;
  try {
    info = JSON.parse(new TextDecoder().decode(manifest.bytes)) as PluginInfo;
  } catch (e) {
    throw new Error(`info.json 不是合法的 JSON：${String(e)}`, { cause: e });
  }
  if (!info.name || !NAME_PATTERN.test(info.name)) {
    throw new Error("info.json 的 name 不合格式（僅允許小寫字母、數字與連字號）。");
  }

  const prefix = manifest.path === "info.json" ? "" : manifest.path.slice(0, -"info.json".length);
  return {
    name: info.name,
    info,
    files: entries.map(({ path, bytes }) => ({ path: path.slice(prefix.length), data: encodeBase64(bytes) })),
  };
}
