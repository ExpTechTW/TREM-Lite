/**
 * The plugin host's link to Rust (`src-tauri/src/plugin.rs`).
 *
 * Small on purpose: Rust stores files, this file moves bytes, and every
 * decision — what is verified, what is enabled, what runs — is made in TS where
 * it can be read and tested.
 */
import { invoke } from "@tauri-apps/api/core";

import { inTauri } from "@/lib/env";

import { decodeBase64, encodeBase64 } from "./base64";
import type { PluginDir, PluginFile, PluginKey } from "./types";

/** True once the host can do anything at all. */
export const pluginStorageAvailable = inTauri;

export async function pluginRoot(): Promise<string> {
  if (!inTauri) return "";
  return invoke<string>("plugin_root");
}

/**
 * Every installed plugin and every file in it, in one call.
 *
 * One call, not one per file: the tree it returns is what backs the synchronous
 * `fs.readFileSync` a plugin was written against.
 */
export async function readPlugins(): Promise<Map<string, Map<string, Uint8Array>>> {
  if (!inTauri) return new Map();
  const dirs = await invoke<PluginDir[]>("plugin_list");
  return new Map(
    dirs.map((dir) => [
      dir.name,
      new Map(dir.files.map((file) => [file.path, decodeBase64(file.data)] as [string, Uint8Array])),
    ]),
  );
}

/**
 * The `.trem` archives sitting in the plugin folder, unopened.
 *
 * A user who finds the folder can copy a package into it instead of dragging
 * one onto the settings page; the host installs what it finds at boot.
 */
export async function pluginPackages(): Promise<PluginFile[]> {
  if (!inTauri) return [];
  return invoke<PluginFile[]>("plugin_packages");
}

/** Delete one of those archives, once its contents are installed. */
export async function discardPackage(name: string): Promise<void> {
  if (!inTauri) return;
  await invoke("plugin_discard", { name });
}

/** One file a plugin wrote, or `null` to delete it. */
export async function writePluginFile(plugin: string, path: string, data: Uint8Array | null): Promise<void> {
  if (!inTauri) return;
  await invoke("plugin_write", { plugin, path, data: data ? encodeBase64(data) : null });
}

export async function installPlugin(plugin: string, files: PluginFile[]): Promise<void> {
  await invoke("plugin_install", { plugin, files });
}

export async function removePlugin(plugin: string): Promise<void> {
  await invoke("plugin_remove", { plugin });
}

/** Extra signing keys, `<app_config_dir>/plugin-keys/*.pem`. */
export async function pluginKeys(): Promise<PluginKey[]> {
  if (!inTauri) return [];
  return invoke<PluginKey[]>("plugin_keys");
}
