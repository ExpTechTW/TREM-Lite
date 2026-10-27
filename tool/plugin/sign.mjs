#!/usr/bin/env node
/**
 * Sign an extension directory.
 *
 * The counterpart of the host's verifier (`packages/core/src/features/plugin/verify.ts`,
 * itself a port of V3's `legacy/src/js/core/verify.js`). What it writes has to
 * reproduce that verifier's arithmetic exactly:
 *
 *   - every file is hashed as **LF-normalised UTF-8 text**, sha256, lowercase hex;
 *   - dot-files, `signature.json` and `trem.json` are not hashed at all
 *     (`trem.json` records where the plugin came from and is written on install);
 *   - the signature is RSA-SHA256 — PKCS#1 v1.5 — over the bytes of
 *     `JSON.stringify(fileHashes)`, base64 encoded. The verifier parses
 *     `signature.json` and re-stringifies it, so the key order written here is
 *     the key order that gets verified.
 *
 * Usage:
 *   node tool/plugin/sign.mjs <plugin-dir> --key <private.pem> [--key-id <id>]
 *
 * `--key-id` names a key the host has in `<app_config_dir>/plugin-keys`;
 * leaving it out signs as ExpTech, which only ExpTech's own key can do.
 */
import { createHash, createSign } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SKIP_HASHING = new Set(["signature.json", "trem.json"]);

function usage(message) {
  if (message) console.error(`錯誤：${message}\n`);
  console.error("用法：node tool/plugin/sign.mjs <plugin-dir> --key <private.pem> [--key-id <id>]");
  process.exit(1);
}

function parseArgs(argv) {
  const out = { dir: null, key: null, keyId: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--key") out.key = argv[++i];
    else if (arg === "--key-id") out.keyId = argv[++i];
    else if (arg.startsWith("-")) usage(`不認識的參數 ${arg}`);
    else if (out.dir) usage("只能指定一個資料夾");
    else out.dir = arg;
  }
  return out;
}

/** Every path to hash, POSIX-separated and relative to `root`. */
function walk(root, dir = root, found = []) {
  for (const name of readdirSync(dir).sort()) {
    // A dot-file is the author's own business, on every level.
    if (name.startsWith(".")) continue;
    const absolute = join(dir, name);
    if (statSync(absolute).isDirectory()) {
      walk(root, absolute, found);
      continue;
    }
    const path = relative(root, absolute).split(sep).join("/");
    if (!SKIP_HASHING.has(path)) found.push(path);
  }
  return found;
}

/** What the verifier hashes: `\r\n` and a lone `\r` both become `\n`. */
function normalize(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

const { dir, key, keyId } = parseArgs(process.argv.slice(2));
if (!dir) usage("請指定擴充功能資料夾");
if (!key) usage("請以 --key 指定簽章用的私鑰");

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(dir, "info.json"), "utf8"));
} catch (e) {
  usage(`讀不到 ${join(dir, "info.json")}：${e.message}`);
}
if (!/^[a-z0-9-]+$/.test(manifest.name ?? "")) {
  usage(`info.json 的 name 不合格式（僅允許小寫字母、數字與連字號）：${manifest.name}`);
}

const fileHashes = {};
for (const path of walk(dir)) {
  fileHashes[path] = createHash("sha256").update(normalize(readFileSync(join(dir, path), "utf8"))).digest("hex");
}

const message = JSON.stringify(fileHashes);
const signer = createSign("SHA256");
signer.update(message);
signer.end();

const signature = signer.sign(readFileSync(key, "utf8"), "base64");
const record = { fileHashes, signature, ...(keyId ? { keyId } : {}) };
writeFileSync(join(dir, "signature.json"), `${JSON.stringify(record, null, 2)}\n`);

console.log(`已簽署 ${manifest.name} ${manifest.version ?? ""}（${Object.keys(fileHashes).length} 個檔案）`);
if (!keyId) {
  console.log("未指定 --key-id，簽章會以 ExpTech 官方金鑰驗證；只有官方私鑰簽得出來。");
}
