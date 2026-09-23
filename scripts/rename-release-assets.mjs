// Renames a GitHub release's Tauri-default asset names to the friendly, industry
// convention `TREM-Lite-<version>-<os>-<arch>.<ext>` (arm64 / x64 / ia32).
// Updater signatures depend on file content, not name, so renaming never
// invalidates them. latest.json is written afterwards, from the final names, by
// tool/release/manifest.py.
//
// CI usage (release.yml):  bun scripts/rename-release-assets.mjs
//   env: GH_TOKEN, GITHUB_REPOSITORY (owner/repo), TAG (e.g. v26.2 or 26w39a)
// Self-test (no network):  bun scripts/rename-release-assets.mjs --selftest

/** Normalize any arch spelling to the user-facing set. Order matters. */
function normArch(s) {
  if (/aarch64|arm64/i.test(s)) return "arm64";
  if (/x86_64|amd64|x64/i.test(s)) return "x64";
  if (/i686|i386|ia32|x86/i.test(s)) return "ia32";
  return null;
}

const EXTS = ["app.tar.gz", "dmg", "deb", "exe"];
const OS_BY_EXT = {
  "app.tar.gz": "mac",
  dmg: "mac",
  deb: "linux",
  exe: "win",
};

/**
 * Map a Tauri-default asset name → friendly name.
 * Returns null for names we leave untouched (latest.json).
 */
export function friendly(name, version) {
  if (name === "latest.json") return null;

  const isSig = name.endsWith(".sig");
  const base = isSig ? name.slice(0, -4) : name;

  const ext = EXTS.find((e) => base.toLowerCase().endsWith("." + e.toLowerCase()));
  if (!ext) return null; // unknown → leave as-is

  const os = OS_BY_EXT[ext];
  // arch token lives in the part before the extension.
  const stem = base.slice(0, base.length - ext.length - 1);
  // No arch → left as-is rather than guessed, so the manifest check in
  // release.yml fails on the platform it cannot find.
  const arch = normArch(stem);
  if (!arch) return null;

  return `TREM-Lite-${version}-${os}-${arch}.${ext}${isSig ? ".sig" : ""}`;
}

// --------------------------------------------------------------------------
function selftest() {
  const v = "4.0.0";
  const cases = {
    "TREM-Lite_4.0.0_aarch64.dmg": "TREM-Lite-4.0.0-mac-arm64.dmg",
    "TREM-Lite_4.0.0_x64.dmg": "TREM-Lite-4.0.0-mac-x64.dmg",
    "TREM-Lite_aarch64.app.tar.gz": "TREM-Lite-4.0.0-mac-arm64.app.tar.gz",
    "TREM-Lite_x64.app.tar.gz.sig": "TREM-Lite-4.0.0-mac-x64.app.tar.gz.sig",
    "TREM-Lite.app.tar.gz": null,
    "TREM-Lite_4.0.0_amd64.deb": "TREM-Lite-4.0.0-linux-x64.deb",
    "TREM-Lite_4.0.0_arm64.deb": "TREM-Lite-4.0.0-linux-arm64.deb",
    "TREM-Lite_4.0.0_arm64.deb.sig": "TREM-Lite-4.0.0-linux-arm64.deb.sig",
    "TREM-Lite_4.0.0_x64-setup.exe": "TREM-Lite-4.0.0-win-x64.exe",
    "TREM-Lite_4.0.0_arm64-setup.exe": "TREM-Lite-4.0.0-win-arm64.exe",
    "TREM-Lite_4.0.0_x86-setup.exe": "TREM-Lite-4.0.0-win-ia32.exe",
    "TREM-Lite_4.0.0_x64-setup.exe.sig": "TREM-Lite-4.0.0-win-x64.exe.sig",
    "latest.json": null,
  };
  let ok = true;
  for (const [input, want] of Object.entries(cases)) {
    const got = friendly(input, v);
    const pass = got === want;
    if (!pass) ok = false;
    console.log(`${pass ? "✓" : "✗"} ${input}\n    → ${got}${pass ? "" : `   (expected ${want})`}`);
  }
  console.log(ok ? "\nALL PASS" : "\nFAILURES");
  process.exit(ok ? 0 : 1);
}

async function main() {
  const token = process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const tag = process.env.TAG;
  if (!token || !repo || !tag) throw new Error("need GH_TOKEN, GITHUB_REPOSITORY, TAG");
  const version = tag.replace(/^v/, "");

  const gh = (path, opts = {}) =>
    fetch(`https://api.github.com${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(opts.headers || {}),
      },
    });

  // Find the release by tag (drafts included).
  const releases = await (await gh(`/repos/${repo}/releases?per_page=100`)).json();
  const release = releases.find((r) => r.tag_name === tag);
  if (!release) throw new Error(`release for tag ${tag} not found`);

  for (const a of release.assets) {
    const nn = friendly(a.name, version);
    if (!nn || nn === a.name) continue;
    const res = await gh(`/repos/${repo}/releases/assets/${a.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: nn }),
    });
    console.log(`${res.ok ? "renamed" : "FAILED " + res.status} ${a.name} → ${nn}`);
  }
}

if (process.argv.includes("--selftest")) selftest();
else await main();
