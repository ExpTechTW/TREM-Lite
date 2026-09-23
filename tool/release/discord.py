#!/usr/bin/env python3
"""Posts a release's changelog to Discord.

Ported from DPIP (tool/release/discord.py).

    DISCORD_WEBHOOK=... tool/release/discord.py 26w39a
    DISCORD_WEBHOOK=... tool/release/discord.py 26w39a --dry-run

The release note is written for GitHub and has to be cut down before Discord
will take it: an embed description stops at 4,096 characters. What is dropped,
and why:

  * every language after 中文, which lives inside `<details>` — Discord does not
    render that tag at all, so it would arrive as a wall of unfolded duplicate
    text;
  * the compare link and the build marker at the foot — Discord prints the HTML
    comment GitHub hides, and the release page linked at the end is one click
    from the comparison;
  * the commit links. The short hash stays, the URL goes: the release page is
    one click from every commit.

The platform marks tool/release/notes.sh writes are unicode emoji. Where the
server has its own emoji for a platform — configured per workflow, see
`PLATFORM_EMOJI` — the mark is swapped for that; otherwise it stays as it is,
which Discord renders too.

**Unlike DPIP, a snapshot with nothing user-visible is not announced.** Every
push to main publishes one, and most are CI or tooling; a channel told "no
user-facing changes" several times a day learns to stop reading it. A release
is always announced.
"""

import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

REPO = os.environ.get("GITHUB_REPOSITORY", "ExpTechTW/TREM-Lite")
DESCRIPTION_LIMIT = int(os.environ.get("TREM_DISCORD_LIMIT", 4096))

# Pre-releases are the everyday case and releases the rare one, so the colour is
# what tells them apart at a glance in a busy channel.
PRERELEASE_COLOUR = 0xE8A33D
RELEASE_COLOUR = 0x3BA55D

# The server's own emoji for a platform, replacing notes.sh's unicode mark.
#
# A guild emoji only renders from its numeric id — `:windows:` stays literal
# text in a webhook message — and that id cannot be read through a webhook
# token (guilds/{id}/emojis answers 401), so it is configuration rather than
# something this script can discover. Unset, the unicode mark stays: a fork
# announcing to its own server then shows 🪟 rather than an emoji it lacks.
PLATFORM_EMOJI = {
    "🪟": os.environ.get("TREM_EMOJI_WINDOWS"),
    "🍎": os.environ.get("TREM_EMOJI_MACOS"),
}

# The run of platform marks notes.sh puts at the start of every entry. Only
# that run is rewritten, so an emoji inside an entry's own text is left alone.
LEADING_MARKS = re.compile(r"^- ((?:🌐|🪟|🍎|🐧)+) ", re.M)


def api(path: str) -> dict:
    """A release, read back from the API.

    Retried on 404 because this runs seconds after the release is published and
    the API is not read-your-writes: a release that certainly exists can answer
    404 for a moment, and the announcement would be lost to a race nobody could
    reproduce afterwards.
    """
    fixture = os.environ.get("TREM_RELEASE_JSON")
    if fixture:
        return json.loads(pathlib.Path(fixture).read_text())

    for attempt in range(3):
        try:
            return _get(path)
        except urllib.error.HTTPError as error:
            if error.code != 404 or attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))
    raise AssertionError("unreachable")


def _get(path: str) -> dict:
    request = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/{path}",
        headers={"Accept": "application/vnd.github+json"},
    )
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def to_discord(body: str) -> str:
    """The 中文 half of a release note, in what Discord can actually show."""
    # Everything after the first `<details>` is another language; after the
    # rule, the compare link. Neither survives the trip.
    body = re.split(r"^<details>|^---$", body, maxsplit=1, flags=re.M)[0]
    body = re.sub(r"\(\[`([0-9a-f]{7,8})`\]\([^)]*\)\)", r"`\1`", body)
    body = re.sub(r"<!--.*?-->", "", body, flags=re.S)
    body = LEADING_MARKS.sub(
        lambda m: "- " + "".join(PLATFORM_EMOJI.get(c) or c for c in m.group(1)) + " ",
        body,
    )
    return re.sub(r"\n{3,}", "\n\n", body).strip()


def sections(body: str) -> list[tuple[str, list[str]]]:
    """The note split at its category headings, each as a list of entries."""
    out: list[tuple[str, list[str]]] = []
    for block in re.split(r"(?=^### )", body, flags=re.M):
        block = block.strip()
        if not block:
            continue
        title, _, rest = (
            block.partition("\n") if block.startswith("### ") else ("", "", block)
        )
        items = [ln for ln in rest.strip().splitlines() if ln.strip()]
        out.append((title[4:].strip(), items))
    return out


def share(parts: list[tuple[str, list[str]]], room: int) -> list[list[str]]:
    """Splits [room] between the categories, evenly, and without waste.

    Evenly, because the alternative is what a naive cut does: fill from the top
    until the budget runs out, which spends everything on 新功能 and posts
    錯誤修正 as an empty heading — and a release where the fixes are the point
    then reads as a release with no fixes.

    Without waste, because an equal share is a floor and not a quota: a
    category that needs less than its share hands the rest back, and the loop
    repeats until nothing more can be given away. Only then is anything cut.
    """
    keep: list[list[str]] = [[] for _ in parts]
    left = room

    # Round by round, an equal quota each, until a whole round adds nothing.
    # Progress is the condition, not completion: stopping when no category
    # *finishes* leaves budget unspent while two hungry categories both starve.
    while left > 0:
        hungry = [i for i in range(len(parts)) if len(keep[i]) < len(parts[i][1])]
        if not hungry:
            break
        quota = max(left // len(hungry), 1)
        spent = 0
        for i in hungry:
            used = 0
            for item in parts[i][1][len(keep[i]) :]:
                if used + len(item) + 1 > quota:
                    break
                used += len(item) + 1
                keep[i].append(item)
            spent += used
        if spent == 0:
            break
        left -= spent
    return keep


def fit(text: str, room: int) -> str:
    """The per-embed backstop: [share] bounds the message, this bounds one embed.

    Cut on an item boundary. A description cut at the character limit ends
    inside somebody's changelog entry, which reads as a bug in that entry
    rather than as a limit in Discord.
    """
    if len(text) <= room:
        return text
    cut = text.rfind("\n", 0, room - 20)
    return text[: cut if cut > 0 else room - 20].rstrip() + "\n…"


def budget(body: str, hashes: bool) -> str:
    """Drops the short commit hashes, from entries only.

    Line by line rather than over the whole note: the snapshot notice at the top
    names the commit it was cut from, and a blanket substitution would eat it.
    """
    if hashes:
        return body
    return "\n".join(
        re.sub(r"\s*`[0-9a-f]{7,8}`", "", line) if line.startswith("- ") else line
        for line in body.splitlines()
    )


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry_run = "--dry-run" in sys.argv
    if not args:
        print("usage: tool/release/discord.py <tag> [--dry-run]", file=sys.stderr)
        return 2
    tag = args[0]

    release = api(f"releases/tags/{tag}")
    url = release["html_url"]
    link = f"\n\n[在 GitHub 上檢視完整更新日誌 →]({url})"

    colour = PRERELEASE_COLOUR if release["prerelease"] else RELEASE_COLOUR
    body = to_discord(release.get("body") or "")

    if release["prerelease"] and not any(name for name, _ in sections(body)):
        print(f"discord: {tag} has nothing user-visible — not announced")
        return 0

    title_text = release["name"] or tag
    footer = "測試版" if release["prerelease"] else "正式版"
    heading = f"# {title_text}"

    # The hashes go before any entry does. Losing a hash costs a click on the
    # release page linked at the bottom; losing an entry means a change shipped
    # and nobody was told, which is the one thing this message exists to prevent.
    for hashes in (True, False):
        parts = sections(budget(body, hashes))
        # The untitled block before the first heading is the note's preamble:
        # its first line becomes the subtext under the title, anything after it
        # an ordinary paragraph. Line by line, because joining them first leaves
        # the Markdown italics of one line glued to the next.
        lines = []
        if parts and not parts[0][0]:
            lines = [ln.strip().strip("_").strip() for ln in parts[0][1]]
            parts = parts[1:]
        header = heading
        if lines:
            header += f"\n-# {lines[0]}"
        if len(lines) > 1:
            header += "\n\n" + "\n".join(lines[1:])

        # One embed, so the ceiling is a description's 4,096 and not a message's
        # 6,000. Measured from the strings rather than reserved as a round
        # number, so nothing is cut to pay for overhead that is not there.
        overhead = (
            len(header)
            + len(link)
            + sum(len(f"\n\n### {name}\n") for name, _ in parts)
        )
        room = DESCRIPTION_LIMIT - overhead
        if sum(len(i) + 1 for _, items in parts for i in items) <= room:
            break

    kept = share(parts, room)

    blocks = [header]
    for (name, items), shown in zip(parts, kept):
        block = f"### {name}\n" + "\n".join(shown)
        if len(shown) < len(items):
            # Says how much is missing, per category. A silent cut reads as a
            # quiet release rather than a long one.
            block += f"\n… ({len(shown)}/{len(items)})"
        blocks.append(block)

    embed = {
        "description": fit("\n\n".join(blocks), DESCRIPTION_LIMIT - len(link)) + link,
        "color": colour,
        "footer": {"text": footer},
    }
    if release.get("published_at"):
        embed["timestamp"] = release["published_at"]

    payload = {"username": "TREM-Lite", "embeds": [embed]}

    if dry_run:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        shown = sum(len(k) for k in kept)
        total = sum(len(items) for _, items in parts)
        print(
            f"\n描述 {len(embed['description'])} / {DESCRIPTION_LIMIT}"
            f"，條目 {shown}/{total}，commit hash {'保留' if hashes else '捨棄'}",
            file=sys.stderr,
        )
        return 0

    webhook = os.environ.get("DISCORD_WEBHOOK")
    if not webhook:
        print("DISCORD_WEBHOOK is not set", file=sys.stderr)
        return 1

    request = urllib.request.Request(
        webhook,
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            # Discord answers 403 to the default `Python-urllib/3.x`, with no
            # body and nothing that says why. Any other agent string is fine.
            "User-Agent": f"TREM-release-notifier (+https://github.com/{REPO})",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            print(f"discord: HTTP {response.status}")
        return 0
    except urllib.error.HTTPError as error:
        # Discord says what it disliked in the body; the exception alone says
        # only the number, and a stack trace here names urllib rather than the
        # field it rejected.
        print(f"discord: HTTP {error.code}", file=sys.stderr)
        print(error.read().decode(errors="replace")[:800], file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
