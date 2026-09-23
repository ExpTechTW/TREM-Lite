#!/usr/bin/env python3
"""Writes a release's latest.json — the Tauri updater manifest — in one pass.

    GITHUB_TOKEN=... tool/release/manifest.py <release-id> <tag> <semver>
    TREM_ASSETS_JSON=assets.json tool/release/manifest.py <release-id> <tag> <semver> --dry-run

tauri-action can write it, but from every build at once: each lists the assets,
downloads latest.json, merges its own platform in, deletes the old one and
uploads the result, with no lock around any of it. Two builds that finish
together either drop each other's entry — silently, so that platform never
updates — or collide on the delete, and 26w39c lost its Windows arm64 build to
a 404 there. So the builds are told not to (`includeUpdaterJson: false`) and
this runs once, in `publish`, after every build has uploaded and every asset
has its final name.

It follows tauri-action's layout (checked against the one it wrote for
26w39b): for every updater artifact with a `.sig` beside it, an
`{os}-{arch}-{installer}` key, plus a plain `{os}-{arch}` key for the preferred
installer — the NSIS installer on Windows and the app bundle on macOS, the only
ones built there. Linux gets no plain key; see PREFERRED.
"""

import datetime
import json
import os
import pathlib
import re
import sys
import urllib.request

REPO = os.environ.get("GITHUB_REPOSITORY", "ExpTechTW/TREM-Lite")

# The friendly names scripts/rename-release-assets.mjs gives the assets:
# TREM-Lite-<label>-<os>-<arch>.<ext>
NAME = re.compile(
    r"^TREM-Lite-.+-(?P<os>mac|linux|win)-(?P<arch>x64|arm64|ia32)"
    r"\.(?P<ext>app\.tar\.gz|deb|exe)$"
)
OS = {"mac": "darwin", "linux": "linux", "win": "windows"}
ARCH = {"x64": "x86_64", "arm64": "aarch64", "ia32": "i686"}
INSTALLER = {
    "app.tar.gz": "app",
    "deb": "deb",
    "exe": "nsis",
}
# What a plain `{os}-{arch}` key points at: the updater's fallback when no key
# names its own installer. Linux is left out on purpose. An AppImage from an
# earlier snapshot would fall back to that key, and the plugin writes whatever
# it downloads over the AppImage without checking that it is one, so a .deb
# there would replace the app with a file that cannot run. With no key, those
# installs find no update and keep working.
PREFERRED = {"darwin": "app", "windows": "nsis"}


def api(method: str, path: str, **kwargs) -> urllib.request.Request:
    url = path if path.startswith("https://") else f"https://api.github.com/repos/{REPO}/{path}"
    request = urllib.request.Request(url, method=method, **kwargs)
    request.add_header("Authorization", f"Bearer {os.environ['GITHUB_TOKEN']}")
    request.add_header("X-GitHub-Api-Version", "2022-11-28")
    return request


def assets(release_id: str) -> list[dict]:
    fixture = os.environ.get("TREM_ASSETS_JSON")
    if fixture:
        return json.loads(pathlib.Path(fixture).read_text())
    out, page = [], 1
    while True:
        request = api("GET", f"releases/{release_id}/assets?per_page=100&page={page}")
        with urllib.request.urlopen(request, timeout=30) as response:
            batch = json.load(response)
        out += batch
        if len(batch) < 100:
            return out
        page += 1


def signature(asset: dict) -> str:
    """A `.sig` asset's contents: the signature, exactly as tauri-action copies it."""
    if "signature" in asset:  # fixture
        return asset["signature"]
    request = api("GET", f"releases/assets/{asset['id']}")
    request.add_header("Accept", "application/octet-stream")
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode()


def build(tag: str, version: str, listed: list[dict]) -> dict:
    by_name = {a["name"]: a for a in listed}
    platforms: dict[str, dict] = {}
    for name in sorted(by_name):
        match = NAME.match(name)
        sig = by_name.get(f"{name}.sig")
        if not match or not sig:
            continue  # not an updater artifact (a .dmg, a .sig itself)
        os_ = OS[match["os"]]
        arch = ARCH[match["arch"]]
        installer = INSTALLER[match["ext"]]
        entry = {
            "signature": signature(sig),
            "url": f"https://github.com/{REPO}/releases/download/{tag}/{name}",
        }
        platforms[f"{os_}-{arch}-{installer}"] = entry
        if installer == PREFERRED.get(os_):
            platforms[f"{os_}-{arch}"] = entry
    return {
        "version": version,
        "notes": "",
        "pub_date": datetime.datetime.now(datetime.UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "platforms": dict(sorted(platforms.items())),
    }


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 3:
        print(__doc__.split("\n\n")[1], file=sys.stderr)
        return 2
    release_id, tag, version = args
    listed = assets(release_id)
    manifest = build(tag, version, listed)
    body = json.dumps(manifest, indent=2).encode()

    if "--dry-run" in sys.argv:
        sys.stdout.write(body.decode() + "\n")
        return 0

    # A re-run finds the previous attempt's manifest; replace it rather than
    # fail on the name.
    for asset in listed:
        if asset["name"] == "latest.json":
            urllib.request.urlopen(api("DELETE", f"releases/assets/{asset['id']}"), timeout=30)
    upload = api(
        "POST",
        f"https://uploads.github.com/repos/{REPO}/releases/{release_id}/assets?name=latest.json",
        data=body,
    )
    upload.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(upload, timeout=30) as response:
        print(f"latest.json: {len(manifest['platforms'])} entries, HTTP {response.status}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
