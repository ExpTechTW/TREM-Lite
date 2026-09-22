#!/usr/bin/env bash
# The one place a version is decided. Everything else reads it from here.
#
# Ported from DPIP (tool/release/version.sh) and adapted: TREM-Lite ships
# through GitHub releases and the Tauri updater rather than through Apple and
# Google, so the store-specific parts are replaced by `semver`, which is what
# the updater compares.
#
# Six values, deliberately unrelated to each other:
#
#   label   what a human sees                26.2        26w39a
#   train   the release being worked toward  26.2        26.2
#   semver  what the updater compares        26.2.0      26.2.0-26w39a
#   msi     what Windows Installer reads     26.2.0.312  26.2.0.313
#   code    a monotonic build ordinal        426000312   426000313
#   date    the day the build was cut        26-09-22    26-09-22
#
# They are separated because they answer different questions:
#
#   * `label` is the name. Minecraft-style: `<yy>.<n>` for a release, and
#     `<yy>w<week><letter>` for a snapshot. Free text; it is what a release is
#     called and what the app shows.
#
#   * `train` is the release a snapshot precedes.
#
#   * `semver` exists because the Tauri updater decides "is this newer?" by
#     semver comparison of `tauri.conf.json`'s version, so the value written
#     there must parse as semver — `26.2` does not. A snapshot becomes a
#     PRE-RELEASE of its train (`26.2.0-26w39a`), which semver orders *before*
#     `26.2.0`: exactly right, since the snapshot comes first.
#
#   * `msi` exists because Windows Installer reads neither of the above. It
#     takes `major.minor.build.revision`, all numeric — the first two at most
#     255, the last two at most 65535 — so a snapshot's `-26w39a` is not a
#     version it can express, and Tauri refuses to build the MSI at all. (The
#     first snapshot run failed on all three Windows targets exactly there.)
#     The semver core plus this year's commit count, the same ordinal `code`
#     carries. Tauri's `allowDowngrades` is on by default, so the order of these
#     numbers never blocks an install; they only have to be valid, and to tell
#     one build from another in Apps & Features.
#
#   * `code` only has to go up. It is not used by the updater; it is the
#     legible ordinal for support conversations and CI bookkeeping.
#
# Usage:  eval "$(tool/release/version.sh)"   → TREM_LABEL, TREM_TRAIN, …
#         tool/release/version.sh --json      → one JSON object
#         tool/release/version.sh --write     → stamp it into the repo
#
# Needs full history: run actions/checkout with `fetch-depth: 0`.
set -euo pipefail

# The code is `4 | yy | commits-this-year`, read straight off the digits:
#
#   426000312  =  generation 4, year 2026, the 312th commit of 2026
#
# This year's count, not the total: it keeps the digits comparable between
# years and cannot drift toward the million ceiling as the repo ages. It is
# monotonic all the same — a new year adds 1,000,000 while the count restarts
# near zero.
#
# The leading generation digit clears the versions the app has already shipped
# (4.0.0 and earlier), so no previously published build can outrank a new one.
readonly SCHEME=4

readonly TZONE='Asia/Taipei'

root="$(git rev-parse --show-toplevel)"

commit_ts="$(git log -1 --format=%ct HEAD)"
stamp() { # <format>
  TZ="$TZONE" date -r "$commit_ts" "+$1" 2>/dev/null ||
    TZ="$TZONE" date -d "@$commit_ts" "+$1"
}

# Asia/Taipei, not UTC. A week here is the week the people who read the label
# are living in, and they are eight hours ahead: computed in UTC, every Monday
# between 00:00 and 08:00 Taipei falls in the *previous* ISO week.
year="$(stamp %y)"
week="$(stamp %V)"
week=$((10#$week)) # %V has a leading zero; the label does not want one.
date="$(stamp %y-%m-%d)"

year_start="$(stamp %Y)-01-01T00:00:00+08:00"
commits="$(git rev-list --count HEAD --since="$year_start")"
code=$((SCHEME * 100000000 + 10#$year * 1000000 + commits))

# `v[0-9]*`, not `git describe --exact-match`. Every published snapshot is
# tagged too (`26w39a`), and describe answers with whichever tag it likes. The
# `v` prefix is the only thing that makes a build a release, and it is the one
# part a human types.
exact_tag="$(git tag --points-at HEAD --list 'v[0-9]*' --sort=-v:refname | head -n 1 || true)"
last_tag="$(git tag --list 'v[0-9]*' --sort=-v:refname | head -n 1 || true)"

letter_for() { # <n>  → a, b, … z, aa
  local i=$(($1 - 1)) out=""
  while :; do
    out="$(printf "\\$(printf '%03o' $((97 + i % 26)))")$out"
    i=$((i / 26 - 1))
    [ "$i" -lt 0 ] && break
  done
  printf '%s' "$out"
}

if [ -n "$exact_tag" ]; then
  # A release: the tag is the label. `26.2.1` advertises as train `26.2`.
  label="${exact_tag#v}"
  if [[ "$label" =~ ^([0-9]+)\.([0-9]+)(\.([0-9]+))?$ ]]; then
    train="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"
    semver="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[4]:-0}"
  else
    train="$label"
    semver="$label"
  fi
else
  # A snapshot. The letter counts the snapshots already *published* this week,
  # so this build is the next one. Published, not committed: a push carries
  # several commits but produces one build.
  prefix="${year}w$(printf '%02d' "$week")"
  n=$(($(git tag --list "${prefix}*" | wc -l | tr -d ' ') + 1))
  label="${prefix}$(letter_for "$n")"
  # Count and tag can disagree — a run whose publish step failed after tagging,
  # a tag deleted by hand. Walking forward keeps the name unique, which is what
  # matters: a duplicate tag fails the release at the last step.
  while git rev-parse -q --verify "refs/tags/$label" >/dev/null; do
    n=$((n + 1))
    label="${prefix}$(letter_for "$n")"
  done

  # The train is the release this snapshot precedes: the next number after the
  # newest tag, or the year's first release if there is not one yet.
  if [ -n "$last_tag" ]; then
    tag_year="${last_tag#v}"
    tag_year="${tag_year%%.*}"
    tag_seq="${last_tag#v}"
    tag_seq="$(printf '%s' "$tag_seq" | cut -d. -f2)"
    if [ "$tag_year" = "$year" ]; then
      train="${year}.$((tag_seq + 1))"
    else
      train="${year}.1"
    fi
  else
    train="${year}.1"
  fi
  # A snapshot is a pre-release of its train, so semver orders it BEFORE the
  # release — which is the real ordering, and stops the updater offering a
  # snapshot to someone on the finished release.
  semver="${train}.0-${label}"
fi

core="${semver%%-*}"
v_major="${core%%.*}"
v_rest="${core#*.}"
v_minor="${v_rest%%.*}"
v_patch="${v_rest#*.}"
msi="${v_major}.${v_minor}.${v_patch}.${commits}"
# Out of range is a hard stop rather than a wrap or a clamp: Tauri would only
# refuse it on the Windows runners, minutes into the build.
if [ "$v_major" -gt 255 ] || [ "$v_minor" -gt 255 ] ||
  [ "$v_patch" -gt 65535 ] || [ "$commits" -gt 65535 ]; then
  echo "version.sh: $msi is not a Windows Installer version" \
    "(major and minor at most 255, the other two at most 65535)" >&2
  exit 1
fi

if [ "${1:-}" = "--write" ]; then
  # A build runner must stamp the version the release was *named* for, not one
  # it recomputes. Recomputing is wrong twice over: the release job has already
  # created `26w39a`, so a fresh run would count it and produce `26w39b`; and
  # the runner's checkout is shallow, so this year's commit count reads 1. The
  # release workflow therefore passes both values down.
  semver="${TREM_SEMVER:-$semver}"
  msi="${TREM_MSI:-$msi}"
  # Every file that carries a version, stamped from the one source above.
  # `code` and `label` are not written anywhere: nothing in the build reads
  # them, and a value with no reader is a value that goes stale.
  for pkg in package.json packages/core/package.json apps/web/package.json \
    apps/desktop/package.json; do
    f="$root/$pkg"
    # Only the top-level "version" key, which is the third line of every one of
    # these files — a blind global replace would rewrite dependency ranges.
    perl -0pi -e 's/^(\s*"version":\s*)"[^"]*"/${1}"'"$semver"'"/m' "$f"
  done
  # tauri.conf.json carries two versions at different depths — the app's and
  # the MSI's — so it is edited as JSON rather than by pattern: a first-match
  # regex rewrites whichever `"version"` happens to come first in the file.
  # Serialising with two-space indent reproduces the file byte for byte.
  CONF="$root/apps/desktop/src-tauri/tauri.conf.json" SEMVER="$semver" MSI="$msi" bun -e '
    const f = process.env.CONF;
    const c = JSON.parse(await Bun.file(f).text());
    c.version = process.env.SEMVER;
    ((c.bundle.windows ??= {}).wix ??= {}).version = process.env.MSI;
    await Bun.write(f, JSON.stringify(c, null, 2) + "\n");
  '
  # Cargo: the package version, which is the first `version =` in the file.
  perl -0pi -e 's/^version = "[^"]*"/version = "'"$semver"'"/m' \
    "$root/apps/desktop/src-tauri/Cargo.toml"
  echo "stamped $semver (msi $msi, label $label, code $code)"
  exit 0
fi

if [ "${1:-}" = "--json" ]; then
  printf '{"label":"%s","train":"%s","semver":"%s","msi":"%s","code":%s,"date":"%s"}\n' \
    "$label" "$train" "$semver" "$msi" "$code" "$date"
else
  printf 'TREM_LABEL=%s\nTREM_TRAIN=%s\nTREM_SEMVER=%s\nTREM_MSI=%s\nTREM_CODE=%s\nTREM_DATE=%s\n' \
    "$label" "$train" "$semver" "$msi" "$code" "$date"
fi
