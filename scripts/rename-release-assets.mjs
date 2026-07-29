// Renames a GitHub release's Tauri-default asset names to the friendly, industry
// convention `TREM-Lite-<version>-<os>-<arch>.<ext>` (arm64 / x64 / ia32), and
// patches latest.json's URLs to match. Updater signatures are embedded INLINE in
// latest.json (not the .sig files), and depend on file CONTENT not name — so
// renaming never invalidates them.
//
// CI usage (release.yml):  bun scripts/rename-release-assets.mjs
//   env: GH_TOKEN, GITHUB_REPOSITORY (owner/repo), TAG (e.g. v4.0.0)
// Self-test (no network):  bun scripts/rename-release-assets.mjs --selftest

/** Normalize any arch spelling to the user-facing set. Order matters. */
function normArch(s) {
  if (/universal/i.test(s)) return "universal";
  if (/aarch64|arm64/i.test(s)) return "arm64";
  if (/x86_64|amd64|x64/i.test(s)) return "x64";
  if (/i686|i386|ia32|x86/i.test(s)) return "ia32";
  return null;
}

const EXTS = ["app.tar.gz", "AppImage", "dmg", "deb", "rpm", "msi", "exe"];
const OS_BY_EXT = {
  "app.tar.gz": "mac",
  dmg: "mac",
  AppImage: "linux",
  deb: "linux",
  rpm: "linux",
  msi: "win",
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
  let arch = normArch(stem);
  // macOS updater tarball ("TREM-Lite.app.tar.gz") carries no arch → it's the
  // universal build.
  if (!arch && os === "mac") arch = "universal";
  if (!arch) return null;

  return `TREM-Lite-${version}-${os}-${arch}.${ext}${isSig ? ".sig" : ""}`;
}

// --------------------------------------------------------------------------
function selftest() {
  const v = "4.0.0";
  const cases = {
    "TREM-Lite_4.0.0_universal.dmg": "TREM-Lite-4.0.0-mac-universal.dmg",
    "TREM-Lite.app.tar.gz": "TREM-Lite-4.0.0-mac-universal.app.tar.gz",
    "TREM-Lite.app.tar.gz.sig": "TREM-Lite-4.0.0-mac-universal.app.tar.gz.sig",
    "TREM-Lite_4.0.0_amd64.deb": "TREM-Lite-4.0.0-linux-x64.deb",
    "TREM-Lite_4.0.0_arm64.deb": "TREM-Lite-4.0.0-linux-arm64.deb",
    "TREM-Lite-4.0.0-1.x86_64.rpm": "TREM-Lite-4.0.0-linux-x64.rpm",
    "TREM-Lite-4.0.0-1.aarch64.rpm": "TREM-Lite-4.0.0-linux-arm64.rpm",
    "TREM-Lite_4.0.0_amd64.AppImage": "TREM-Lite-4.0.0-linux-x64.AppImage",
    "TREM-Lite_4.0.0_aarch64.AppImage": "TREM-Lite-4.0.0-linux-arm64.AppImage",
    "TREM-Lite_4.0.0_aarch64.AppImage.sig": "TREM-Lite-4.0.0-linux-arm64.AppImage.sig",
    "TREM-Lite_4.0.0_x64-setup.exe": "TREM-Lite-4.0.0-win-x64.exe",
    "TREM-Lite_4.0.0_arm64-setup.exe": "TREM-Lite-4.0.0-win-arm64.exe",
    "TREM-Lite_4.0.0_x86-setup.exe": "TREM-Lite-4.0.0-win-ia32.exe",
    "TREM-Lite_4.0.0_x64-setup.exe.sig": "TREM-Lite-4.0.0-win-x64.exe.sig",
    "TREM-Lite_4.0.0_x64_en-US.msi": "TREM-Lite-4.0.0-win-x64.msi",
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

  // Build old→new map + rename each asset.
  const renames = {};
  for (const a of release.assets) {
    const nn = friendly(a.name, version);
    if (!nn || nn === a.name) continue;
    renames[a.name] = nn;
    const res = await gh(`/repos/${repo}/releases/assets/${a.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: nn }),
    });
    console.log(`${res.ok ? "renamed" : "FAILED " + res.status} ${a.name} → ${nn}`);
  }

  // Patch latest.json's url filenames (signatures are inline → still valid).
  const latest = release.assets.find((a) => a.name === "latest.json");
  if (latest) {
    const raw = await (
      await gh(`/repos/${repo}/releases/assets/${latest.id}`, {
        headers: { Accept: "application/octet-stream" },
      })
    ).text();
    let patched = raw;
    // Longest names first so a shorter name can't clobber a longer superstring.
    for (const [oldN, newN] of Object.entries(renames).sort((a, b) => b[0].length - a[0].length))
      patched = patched.split(oldN).join(newN);
    if (patched !== raw) {
      await gh(`/repos/${repo}/releases/assets/${latest.id}`, { method: "DELETE" });
      const uploadUrl = release.upload_url.replace(/\{.*\}$/, "") + "?name=latest.json";
      const up = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: patched,
      });
      console.log(`${up.ok ? "patched" : "FAILED " + up.status} latest.json (${Object.keys(renames).length} urls)`);
    }
  }
}

if (process.argv.includes("--selftest")) selftest();
else await main();
