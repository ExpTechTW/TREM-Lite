#!/usr/bin/env bun
/**
 * Does the signer and the host's verifier agree?
 *
 * `tool/plugin/sign.mjs` runs in Node; the host verifies in the webview with
 * WebCrypto (`packages/core/src/features/plugin/verify.ts`, itself a port of the
 * Electron build's `verify.js`). They have to agree on four things that are easy
 * to get subtly wrong — which files are covered, that hashes are taken over LF
 * text, that the signed message is the *original* key order of
 * `JSON.stringify(fileHashes)`, and which key a `keyId` selects — so this builds
 * a fixture plugin, signs it with a throwaway key, and checks both directions.
 *
 *   bun tool/plugin/selftest.ts
 */
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePackage, zipSync } from "../../packages/core/src/features/plugin/package.ts";
import { PluginRuntime, PluginTree } from "../../packages/core/src/features/plugin/sandbox.ts";
import { authorNames, localizedText } from "../../packages/core/src/features/plugin/types.ts";
import { verifyPlugin } from "../../packages/core/src/features/plugin/verify.ts";
import {
  compareVersions,
  getVersionPrefixString,
  parseVersion,
  validateVersionRequirement,
} from "../../packages/core/src/features/plugin/version.ts";

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), "trem-plugin-selftest-"));
const plugin = join(work, "sample");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` -> ${detail}`}`);
}

/** The plugin as the host holds it: path → bytes, straight off the disk. */
function load(): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const path of ["info.json", "index.js", "signature.json", "trem.json", "lib/util.js"]) {
    try {
      files.set(path, new Uint8Array(readFileSync(join(plugin, path))));
    } catch {
      /* not every fixture has every file */
    }
  }
  return files;
}

try {
  mkdirSync(join(plugin, "lib"), { recursive: true });
  // Written with CRLF on purpose: Windows tools add them, and both sides must
  // hash the LF form so the same plugin verifies wherever it was unzipped.
  writeFileSync(
    join(plugin, "info.json"),
    '{\r\n  "name": "sample",\r\n  "version": "1.0.0",\r\n  "description": "fixture",\r\n  "author": "ExpTechTW"\r\n}\r\n',
  );
  writeFileSync(join(plugin, "index.js"), "module.exports = class Sample { onLoad() {} };\r\n");
  writeFileSync(join(plugin, "lib", "util.js"), "module.exports = 1;\r\n");
  writeFileSync(join(plugin, "trem.json"), '{"source":"local"}\r\n');
  writeFileSync(join(plugin, ".hidden"), "not hashed\r\n");

  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  writeFileSync(join(work, "private.pem"), privateKey);

  execFileSync(process.execPath, [join(here, "sign.mjs"), plugin, "--key", join(work, "private.pem"), "--key-id", "test"], {
    stdio: "inherit",
  });

  const keys = new Map<string, string>([["test", publicKey]]);

  const signed = await verifyPlugin(load(), keys);
  check("a freshly signed directory verifies", signed.valid, signed.error);
  check("the signature reports its key", signed.keyId === "test", String(signed.keyId));
  check("dot-files stay out of the signature", !JSON.parse(decoder.decode(readFileSync(join(plugin, "signature.json")))).fileHashes[".hidden"]);

  const crlf = await verifyPlugin(load(), new Map());
  check("an unknown key id is reported", crlf.error === "Unknown key ID: test", String(crlf.error));

  const text = decoder.decode(readFileSync(join(plugin, "index.js")));
  writeFileSync(join(plugin, "index.js"), `${text}\r\n// edited\r\n`);
  const edited = await verifyPlugin(load(), keys);
  writeFileSync(join(plugin, "index.js"), text);
  check("an edited file is reported", edited.error === "Modified file: index.js", String(edited.error));

  const extra = load();
  extra.set("extra.js", encoder.encode("// extra\n"));
  const added = await verifyPlugin(extra, keys);
  check("an added file is reported", added.error === "Extra file: extra.js", String(added.error));

  const moved = load();
  moved.set("trem.json", encoder.encode('{"source":"https://example.test/x.trem"}\n'));
  const relocated = await verifyPlugin(moved, keys);
  check("trem.json is outside the signature", relocated.valid, relocated.error);

  const record = JSON.parse(decoder.decode(readFileSync(join(plugin, "signature.json")))) as {
    fileHashes: Record<string, string>;
    signature: string;
    keyId: string;
  };
  const reordered = load();
  reordered.set(
    "signature.json",
    encoder.encode(JSON.stringify({ ...record, fileHashes: Object.fromEntries(Object.entries(record.fileHashes).reverse()) })),
  );
  const shuffled = await verifyPlugin(reordered, keys);
  check("the hash order is part of the signature", shuffled.error === "Invalid signature", String(shuffled.error));

  const parsed = parseVersion("26.1.0-26w40a");
  check("versions parse", parsed?.major === 26 && parsed.minor === 1 && parsed.patch === 0);
  check("versions compare", compareVersions("26.1.0", "26.0.9") === true && compareVersions("26.0.0", "26.1.0") === false);

  // The weekly snapshot tag is part of the version: a plugin may ask for a
  // newer snapshot than the one running, and a snapshot build must not pass
  // `=26.1.0`, which names the release rather than any build of it.
  const snapshot = "26.1.0-26w39a";
  for (const [requirement, wanted, why] of [
    ["26.1.0-26w39a", true, "the same snapshot"],
    ["=26.1.0-26w39a", true, "exactly this snapshot"],
    ["=26.1.0", false, "the release is not this snapshot"],
    [">=26.1.0-26w39a", true, "as new as the one running"],
    [">=26.1.0-26w38a", true, "an older snapshot"],
    [">=26.1.0-26w40a", false, "a newer snapshot"],
    [">=26.1.0", false, "a snapshot sorts below its release"],
    ["<26.1.0", true, "the release it precedes"],
    ["<26.1.0-26w40a", true, "an older snapshot"],
    ["<26.1.0-26w38a", false, "a newer snapshot"],
    [">=26.0.0", true, "the same minor or newer"],
  ] as [string, boolean, string][]) {
    check(
      `${snapshot} ${requirement} is ${wanted} (${why})`,
      validateVersionRequirement(snapshot, requirement) === wanted,
      `wanted ${wanted}`,
    );
  }
  check(
    "pre-release segments compare as numbers",
    validateVersionRequirement("1.2.3-rc.10", ">=1.2.3-rc.9") && !validateVersionRequirement("1.2.3-rc.9", ">=1.2.3-rc.10"),
  );
  check(
    "requirements hold",
    validateVersionRequirement("26.0.0", ">=26.0.0") && !validateVersionRequirement("25.9.0", ">=26.0.0"),
  );

  // Authors write the operator apart from the version often enough that both
  // spellings have to mean the same thing; `==` is read as `=`.
  for (const requirement of [">=26.0.0", ">= 26.0.0", ">=  26.0.0"]) {
    check(`${JSON.stringify(requirement)} is satisfied by 26.1.0-26w39a`, validateVersionRequirement(snapshot, requirement));
  }
  check("a spaced pair of ranges still holds", validateVersionRequirement(snapshot, ">= 26.1.0-26w39a < 26.2.0"));
  check("a spaced pair still refuses", !validateVersionRequirement(snapshot, ">= 26.1.0-26w40a < 26.2.0"));
  check("`==` means `=`", validateVersionRequirement(snapshot, "== 26.1.0-26w39a"));
  check(
    "the refusal message spells the requirement out",
    getVersionPrefixString(">= 1.0.0 < 2.0.0") === "大於等於 1.0.0 且 小於 2.0.0",
    getVersionPrefixString(">= 1.0.0 < 2.0.0"),
  );
  // The published manifests carry `description` as a locale table and `author`
  // as an array (trem-radar-plugin, trem-logger-plugin); the 擴充 page has to
  // get plain text out of either shape.
  check("a localized description picks zh-Hant", localizedText({ zh_tw: "甲", "zh-Hant": "乙" }) === "乙");
  check("a plain description still works", localizedText("說明") === "說明");
  check(
    "authors survive both shapes",
    authorNames(["bamboo0403"]).join(",") === "bamboo0403" && authorNames("whes1015").join(",") === "whes1015",
  );

  // A `.trem` is a zip of the plugin folder. Authors zip on Windows, and
  // Windows' own tools (`Compress-Archive`, 「傳送到 → 壓縮的資料夾」) write `\` in
  // the entry names; both separators and both layouts have to install.
  const bytes = (value: string) => encoder.encode(value);
  const wrapped = parsePackage(
    zipSync({
      "demo\\info.json": bytes('{"name":"demo","version":"1.0.0"}'),
      "demo\\index.js": bytes("module.exports = class {};"),
    }),
  );
  check(
    "a Windows-made archive installs",
    wrapped.name === "demo" && wrapped.files.map((file) => file.path).sort().join(",") === "index.js,info.json",
    JSON.stringify(wrapped.files.map((file) => file.path)),
  );

  const flat = parsePackage(zipSync({ "info.json": bytes('{"name":"flat"}'), "index.js": bytes("x") }));
  check("an archive without a wrapper folder installs", flat.name === "flat" && flat.files.length === 2, String(flat.files.length));

  let refused = "";
  try {
    parsePackage(zipSync({ "info.json": bytes('{"name":"Not A Name"}') }));
  } catch (e) {
    refused = String(e);
  }
  check("a bad plugin name is refused", refused.includes("name 不合格式"), refused);

  // One extension standing on another. `require("other-plugin")` is a *name*,
  // not a path, so it is the only specifier that has to reach out of the
  // asking plugin's folder. Three things have to hold at once: the name finds
  // that plugin's entry (`index.js`, the same file the host loads as the plugin
  // itself), the loaded module keeps its own `fs` — relative paths and writes
  // belong to its owner, not the asker — and a name that is installed but not
  // running says so instead of vanishing.
  const mountFiles = (entries: Record<string, string>) =>
    new Map(Object.entries(entries).map(([path, value]) => [path, bytes(value)]));

  const tree = new PluginTree();
  tree.mount("lib-plugin", mountFiles({
    "index.js": "module.exports = { tag: 'from-lib' };",
    "util.js": `module.exports = { folder: () => require("path").basename(process.cwd()), save: () => require("fs").writeFileSync("note.txt", "hi") };`,
  }));
  tree.mount("consumer", mountFiles({ "index.js": "module.exports = {};" }));

  const writes: string[] = [];
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const runtimeFor = (plugin: string, lookup: (name: string) => PluginRuntime | undefined) =>
    new PluginRuntime({ plugin, tree, pluginDir: `/plugins/${plugin}`, lookup, log, onWrite: (path) => writes.push(`${plugin}:${path}`) });

  const running = new Map<string, PluginRuntime>();
  const lookup = (name: string) => running.get(name);
  const lib = runtimeFor("lib-plugin", lookup);
  running.set("lib-plugin", lib);
  const consumer = runtimeFor("consumer", lookup);

  const loaded = consumer.require("lib-plugin", "/plugins/consumer/index.js") as { tag?: string };
  check("a bare name reaches another plugin's entry", loaded?.tag === "from-lib", JSON.stringify(loaded));
  check("that module is the one the host loads", loaded === lib.loadEntry("index.js"));
  check("that module is cached", consumer.require("lib-plugin", "/plugins/consumer/index.js") === loaded);

  // The path form V3 documented — `../other-plugin/util` — crosses the same
  // boundary, and so does a file the *consumer* reaches for inside it. Both
  // have to run as the owner, or `fs` inside would resolve against the asker.
  const foreign = consumer.require("../lib-plugin/util", "/plugins/consumer/index.js") as { folder: () => string; save: () => void };
  check("a relative path into another plugin still works", typeof foreign?.folder === "function");
  check("a module reached by path keeps its own folder", foreign.folder() === "lib-plugin", foreign.folder());
  foreign.save();
  check("its writes are attributed to its owner", writes.join(",") === "lib-plugin:note.txt", writes.join(","));

  const off = new PluginTree();
  off.mount("disabled", mountFiles({ "index.js": "module.exports = 1;" }));
  const offRuntime = new PluginRuntime({
    plugin: "consumer",
    tree: off,
    pluginDir: "/plugins/consumer",
    lookup: () => undefined,
    log,
    onWrite() {},
  });
  const failure = (specifier: string) => {
    try {
      offRuntime.require(specifier, "/plugins/consumer/index.js");
      return "";
    } catch (e) {
      return String(e);
    }
  };
  check("a disabled plugin is named, not missed", failure("disabled").includes("尚未載入"), failure("disabled"));
  check("the message says which key fixes it", failure("disabled").includes("dependencies"), failure("disabled"));
  check("a package still says npm", failure("lodash").includes("npm 套件"), failure("lodash"));
  check("a nested specifier is not a plugin name", failure("react-dom/client").includes("npm 套件"), failure("react-dom/client"));
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
