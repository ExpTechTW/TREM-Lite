#!/usr/bin/env bash
# Builds a release note out of the changelog lines its commits declare.
#
# Ported from DPIP (tool/release/notes.sh). A commit says what belongs in the
# changelog by carrying one line per entry:
#
#     New(zh-Hant): 地圖可以疊加雷達回波
#     New(en-US): the map can overlay radar echo
#     Fix(zh-Hant): 修正離線時圖層閃爍
#     Fix(en-US): stop layers flickering when offline
#
# Everything here is extracted with one regular expression, which buys three
# things a prose body cannot:
#
#   * **A squash cannot corrupt it.** GitHub concatenates every commit on the
#     branch into one body; that just yields more matching lines, all valid.
#   * **One commit can be more than one entry**, in more than one category.
#   * **It scales past two languages.**
#
# The category is declared, not inferred from the commit type: a user-visible
# change filed under `chore:` would otherwise vanish with nothing to warn
# anyone.
#
# **What a note covers depends on which kind it is**, and the difference is not
# cosmetic:
#
#   snapshot   commits since the previous tag of any kind — a delta, because
#              whoever reads it already has the one before.
#   release    commits since the previous *release* tag — cumulative, because
#              someone upgrading 26.1 → 26.2 never saw a single snapshot in
#              between, and a delta would describe a fraction of what changed.
#
# Usage:  tool/release/notes.sh <label> <code> [--release]
set -euo pipefail

label="${1:?label required}"
code="${2:?build code required}"
kind="${3:-}"

# The primary language, printed unfolded. Every other language is published in
# its own folded block.
readonly PRIMARY='zh-Hant'

# Category → heading, per language. Adding a language means adding rows here and
# a locale to tool/check/commits.sh; nothing else changes.
heading_for() { # <category> <locale>
  case "$2::$1" in
  zh-Hant::New | zh-Hant-HK::New) printf '🌟 新功能' ;;
  zh-Hant::Optimization | zh-Hant-HK::Optimization) printf '🔌 最佳化' ;;
  zh-Hant::Fix | zh-Hant-HK::Fix) printf '🐞 錯誤修正' ;;
  zh-Hans::New) printf '🌟 新功能' ;;
  zh-Hans::Optimization) printf '🔌 优化' ;;
  zh-Hans::Fix) printf '🐞 错误修复' ;;
  ja-JP::New) printf '🌟 新機能' ;;
  ja-JP::Optimization) printf '🔌 改善' ;;
  ja-JP::Fix) printf '🐞 不具合修正' ;;
  *::New) printf '🌟 New features' ;;
  *::Optimization) printf '🔌 Improvements' ;;
  *::Fix) printf '🐞 Bug fixes' ;;
  esac
}

language_name() { # <locale>
  case "$1" in
  en-US) printf 'English' ;;
  ja-JP) printf '日本語' ;;
  ko-KR) printf '한국어' ;;
  zh-Hans) printf '简体中文' ;;
  zh-Hant-HK) printf '繁體中文（香港）' ;;
  *) printf '%s' "$1" ;;
  esac
}

# Platform marker.
#
# **Deliberately narrower than DPIP's**, which draws an icon on every entry
# because an Android/iOS split is common there and silence would be ambiguous.
# TREM-Lite's split is web vs desktop, and nearly every change is shared — so
# tagging all of them would put the same two words on 95% of the lines and
# teach readers to skip the tag entirely. Here a marker means "this one is
# narrower than usual", which is the thing worth reading. commit.md says to
# omit the trailer when web and desktop are both affected, so an untagged entry
# is a statement, not an omission.
platform_tag() { # <sha>
  case "$(git log -1 --format=%b "$1" |
    sed -n 's/^[Pp]latform: *\([a-zA-Z]*\).*/\1/p' | head -n 1 |
    tr '[:upper:]' '[:lower:]')" in
  web) printf '`Web` ' ;;
  desktop) printf '`桌面` ' ;;
  macos) printf '`macOS` ' ;;
  windows) printf '`Windows` ' ;;
  linux) printf '`Linux` ' ;;
  *) ;;
  esac
}

# Who to credit.
#
# **Not blindly the commit author.** GitHub squashes a pull request into one
# commit and sets its author to whoever pressed the button, demoting everyone
# who wrote it to a `Co-authored-by:` trailer — so the note would credit the
# wrong person, which is worse than crediting nobody. Trailers are read first
# and need no network; the API is the fallback, and the git display name after
# that, which is all a laptop offline can know.
readonly REPO_API='https://api.github.com/repos'
readonly repo_slug="${GITHUB_REPOSITORY:-ExpTechTW/TREM-Lite}"

api_json() { # <path> <python expression over `d`>
  local body status
  body="$(curl -sS --max-time 15 -w '\n%{http_code}' \
    -H 'Accept: application/vnd.github+json' \
    ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} \
    "$REPO_API/$repo_slug/$1" 2>/dev/null)" || return 0
  status="${body##*$'\n'}"
  body="${body%$'\n'*}"

  # Say so, once per call, rather than silently shipping a note that looks
  # finished and credits nobody. Unauthenticated the limit is 60 requests an
  # hour *per IP*, shared with every other job on that runner.
  case "$status" in
  200) ;;
  403 | 429)
    printf 'notes.sh: GitHub rate-limited %s (HTTP %s) — attribution will be incomplete\n' \
      "$1" "$status" >&2
    return 0
    ;;
  *)
    printf 'notes.sh: GitHub returned HTTP %s for %s\n' "$status" "$1" >&2
    return 0
    ;;
  esac

  printf '%s' "$body" | python3 -c "
import json,sys
try: d = json.load(sys.stdin)
except Exception: raise SystemExit
$2" 2>/dev/null || true
}

authors_of() { # <sha>
  local sha="$1" logins="" trailer

  trailer="$(git log -1 --format=%b "$sha" |
    sed -n 's/^[Cc]o-authored-by: *\(.*\) <\(.*\)>.*/\2|\1/p')"
  while IFS='|' read -r email name; do
    [ -n "$name" ] || continue
    # `1234+login@users.noreply.github.com` carries the login; a real address
    # does not, and GitHub will not resolve one — so the name is used as given.
    case "$email" in
    *+*@users.noreply.github.com) logins="$logins ${email#*+}" ;;
    *) logins="$logins $name" ;;
    esac
  done <<EOF
$trailer
EOF
  logins="$(printf '%s' "${logins# }" | tr ' ' '\n' | sed 's/@users.noreply.github.com//' |
    grep -v '^$' | awk '!seen[$0]++' | tr '\n' ' ')"

  if [ -z "${logins// /}" ]; then
    logins="$(api_json "commits/$sha" "print(d['author']['login'] if d.get('author') else '')")"
  fi
  if [ -z "${logins// /}" ]; then
    printf '%s' "$(git log -1 --format=%an "$sha")"
    return
  fi
  # `@a, @b` — every name that wrote it, trailers first.
  printf '%s' "$(printf '%s' "${logins% }" | sed 's/[^ ][^ ]*/@&/g; s/ /, /g')"
}

# The snapshot a change first shipped in — the nearest snapshot tag at or after
# the commit. Only meaningful in a release note; a snapshot's own entries all
# came from itself. It is here because every push to main publishes a snapshot,
# so a tester who has been running them can see which entries they already have.
first_seen_in() { # <sha>
  [ "$kind" = "--release" ] || return 0
  git tag --list '[0-9][0-9]w[0-9][0-9]*' --contains "$1" 2>/dev/null |
    sort | head -n 1
}

if [ "$kind" = "--release" ]; then
  # The previous release, not the previous tag.
  since="$(git tag --list 'v[0-9]*' --sort=-v:refname |
    grep -v "^v${label}\$" | head -n 1 || true)"
else
  since="$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null || true)"
fi
range="${since:+$since..}HEAD"

# One file per category+locale: macOS still ships bash 3.2, which has no
# associative arrays, and this has to run the same on a laptop as on a runner.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

readonly LINE_RE='^(New|Optimization|Fix)\(([A-Za-z]{2,3}(-[A-Za-z0-9]+)*)\):[[:space:]]*(.+)$'

locales=""
for sha in $(git rev-list --no-merges --reverse "$range" 2>/dev/null); do
  # Read the body once: a commit with no changelog line contributes nothing and
  # costs no API call.
  #
  # An entry may be hard-wrapped, and the regex is whole-line, so a
  # continuation would be dropped in silence — shipping a sentence cut
  # mid-clause. Folded back onto its first line, so what the writer wrote is
  # what the reader gets.
  body="$(git log -1 --format=%b "$sha" | awk '
    /^[[:space:]]+[^[:space:]]/ && held { sub(/^[[:space:]]+/, " "); printf "%s", $0; next }
    { if (held) printf "\n"; printf "%s", $0; held = 1 }
    END { if (held) printf "\n" }
  ')"
  printf '%s\n' "$body" | grep -Eq "$LINE_RE" || continue

  tag="$(platform_tag "$sha")"
  who="$(authors_of "$sha")"
  short="$(git log -1 --format=%h "$sha")"
  snapshot="$(first_seen_in "$sha")"

  while IFS= read -r line; do
    printf '%s' "$line" | grep -Eq "$LINE_RE" || continue
    category="$(printf '%s' "$line" | sed -E "s/$LINE_RE/\\1/")"
    locale="$(printf '%s' "$line" | sed -E "s/$LINE_RE/\\2/")"
    text="$(printf '%s' "$line" | sed -E "s/$LINE_RE/\\4/")"
    # The commit is linked from every entry: an entry says what changed, and the
    # link is the only way to ask *how* without going looking for it.
    printf -- '- %s%s — %s ([`%s`](https://github.com/%s/commit/%s))%s\n' \
      "$tag" "$text" "$who" "$short" "$repo_slug" "$sha" \
      "${snapshot:+ · \`$snapshot\`}" \
      >>"$work/$category.$locale"
    case " $locales " in
    *" $locale "*) ;;
    *) locales="$locales $locale" ;;
    esac
  done <<EOF
$body
EOF
done

# Primary first, then the rest alphabetically, so a note's language order does
# not shuffle between builds.
ordered_locales() {
  printf '%s\n' "$PRIMARY"
  for l in $locales; do
    [ "$l" = "$PRIMARY" ] || printf '%s\n' "$l"
  done | sort
}

section() { # <locale>
  local any=0 c file
  for c in New Optimization Fix; do
    file="$work/$c.$1"
    [ -s "$file" ] || continue
    any=1
    printf '### %s\n\n' "$(heading_for "$c" "$1")"
    cat "$file"
    printf '\n'
  done
  if [ "$any" -eq 0 ]; then
    if [ "$1" = "$PRIMARY" ]; then
      printf '_沒有使用者可見的變更。_\n\n'
    else
      printf '_No user-facing changes._\n\n'
    fi
  fi
}

{
  # No heading: GitHub prints the release name above the body, so a `# 26w39a`
  # here would be the same string twice.
  if [ "$kind" = "--release" ]; then
    [ -n "$since" ] && printf '_自 %s 以來的全部變更。_\n\n' "$since"
  else
    printf '_快照，取自 main 的 `%s`。未經審查，可能有問題。_\n\n' \
      "$(git rev-parse --short HEAD)"
  fi

  # 中文 first and unfolded: this is a Taiwanese app, and the language most of
  # its readers want should not be behind a click.
  section "$PRIMARY"

  # Every other language folded. Unlike DPIP there are no parser markers here:
  # nothing in TREM-Lite reads these notes back, so `<details>` alone is enough
  # and GitHub renders it natively.
  for locale in $(ordered_locales); do
    [ "$locale" = "$PRIMARY" ] && continue
    printf '<details>\n<summary>%s</summary>\n\n' "$(language_name "$locale")"
    section "$locale"
    printf '</details>\n\n'
  done

  if [ "$kind" = "--release" ] && [ -n "$since" ]; then
    # The authoritative diff; everything above is the readable one.
    printf -- '---\n\n'
    printf '**完整差異 / Full changelog**: https://github.com/%s/compare/%s...v%s\n\n' \
      "$repo_slug" "$since" "$label"
  fi

  # Machine-readable, invisible in rendered Markdown.
  printf '<!-- trem-build: %s -->\n' "$code"
}
