/**
 * Version requirements, ported from `legacy/src/js/core/plugin.js` with three
 * deliberate corrections:
 *
 * - the weekly snapshot tag is compared, so `26.1.0-26w40a` really is newer
 *   than `26.1.0-26w39a` (V3 treated every snapshot of a version as equal,
 *   because it only ever looked at the first segment of the pre-release);
 * - numeric segments are compared as numbers, so `1.2.3-rc.10` is newer than
 *   `1.2.3-rc.9` (V3 compared them as strings);
 * - a requirement may spell the space after its operator (`">= 1.0.0"`) and may
 *   write `==`; V3 silently failed on both, since it split on every space.
 *
 * Everything else is V3's, including the channel order: a release sorts above
 * `-rc`, above `-pre`, above any snapshot. `26.1.0` is therefore newer than
 * `26.1.0-26w39a`, which is what makes `=26.1.0` refuse to match a snapshot
 * build (that requirement names the release, not the snapshot) and `>=26.1.0`
 * unsatisfied on one. `compareVersions` still returns "v1 >= v2" rather than a
 * three-way compare.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
  version: string;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+([\w.-]+))?$/;
const DIGITS_RE = /^\d+$/;
const SNAPSHOT_RE = /^(\d{2}|\d{4})w(\d{1,2})([a-z])?$/i;

export function parseVersion(version: string): ParsedVersion | null {
  const match = VERSION_RE.exec(version ?? "");
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] ? match[4].split(".") : [],
    build: match[5] ? match[5].split(".") : [],
    version,
  };
}

/** release = 3, `-rc` = 2, `-pre` = 1, any other pre-release (a snapshot) = 0. */
export function getVersionPriority(version: string): number {
  if (!version) return 0;
  const parsed = parseVersion(version);
  if (!parsed) return 0;
  const prerelease = parsed.prerelease[0];
  if (!prerelease) return 3;
  if (prerelease === "rc") return 2;
  if (prerelease === "pre") return 1;
  return 0;
}

/** A weekly build tag such as `26w39a`: two-digit year, week, optional letter. */
interface WeekSnapshot {
  year: number;
  week: number;
  letter: string;
}

function parseSnapshot(segment: string): WeekSnapshot | null {
  const match = SNAPSHOT_RE.exec(segment);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  return {
    year: year < 100 ? 2000 + year : year,
    week: parseInt(match[2], 10),
    letter: (match[3] ?? "").toLowerCase(),
  };
}

function order(left: number, right: number): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function orderText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** One `-a.b.c` segment: snapshots by year/week/letter, digits as numbers. */
function compareSegment(left: string, right: string): number {
  const leftSnapshot = parseSnapshot(left);
  const rightSnapshot = parseSnapshot(right);
  if (leftSnapshot && rightSnapshot) {
    return (
      order(leftSnapshot.year, rightSnapshot.year) ||
      order(leftSnapshot.week, rightSnapshot.week) ||
      orderText(leftSnapshot.letter, rightSnapshot.letter)
    );
  }
  if (DIGITS_RE.test(left) && DIGITS_RE.test(right)) {
    return order(parseInt(left, 10), parseInt(right, 10));
  }
  return orderText(left, right);
}

/** Three-way compare of the pre-release segments; the shorter one sorts first. */
function compareSegments(left: string[], right: string[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const one = left[index];
    const other = right[index];
    // `1.2.3-rc` sorts below `1.2.3-rc.1`, the way semver counts them.
    if (one === undefined) return -1;
    if (other === undefined) return 1;
    const result = compareSegment(one, other);
    if (result !== 0) return result;
  }
  return 0;
}

function compareParsed(one: ParsedVersion, other: ParsedVersion): number {
  const core = order(one.major, other.major) || order(one.minor, other.minor) || order(one.patch, other.patch);
  if (core !== 0) return core;
  const channel = order(getVersionPriority(one.version), getVersionPriority(other.version));
  if (channel !== 0) return channel;
  return compareSegments(one.prerelease, other.prerelease);
}

export function isExactVersionMatch(v1: string, v2: string): boolean {
  const parsed1 = parseVersion(v1);
  const parsed2 = parseVersion(v2);
  if (!parsed1 || !parsed2) return false;
  return compareParsed(parsed1, parsed2) === 0;
}

/** True when `v1` is the same version as `v2` or newer. */
export function compareVersions(v1: string, v2: string): boolean {
  const parsed1 = parseVersion(v1);
  const parsed2 = parseVersion(v2);
  if (!parsed1 || !parsed2) return false;
  return compareParsed(parsed1, parsed2) >= 0;
}

/** One `operator + version` pair, e.g. `>=1.0.0`. */
interface VersionRange {
  operator: string;
  version: string;
}

/**
 * `">=1.0.0 <2.0.0"` keeps V3's meaning — every range has to hold — and the
 * spelling people reach for first also works: an operator that stands alone
 * takes the next token as its version, so `">= 1.0.0"` and `">=1.0.0"` are the
 * same requirement, and `==` is read as `=`.
 */
function parseRanges(required: string): VersionRange[] {
  const tokens = required.trim().split(/\s+/).filter(Boolean);
  const ranges: VersionRange[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    let token = tokens[index];
    if (/^[><=]+$/.test(token) && index + 1 < tokens.length) {
      index += 1;
      token += tokens[index];
    }
    const matched = /^[><=]+/.exec(token)?.[0];
    ranges.push({
      operator: matched === "==" ? "=" : (matched ?? ">="),
      // A bare version keeps its digits: only what was matched is an operator.
      version: token.slice(matched?.length ?? 0),
    });
  }
  return ranges;
}

/** `">=1.0.0"`, `"<2.0.0"`, `"=1.2.3"`, or several ranges separated by spaces. */
export function validateVersionRequirement(current: string, required: string): boolean {
  const ranges = parseRanges(required);
  if (ranges.length === 0) return false;
  return ranges.every(({ operator, version }) => {
    switch (operator) {
      case "=":
        return isExactVersionMatch(current, version);
      case ">=":
        return compareVersions(current, version);
      case ">":
        return compareVersions(current, version) && !isExactVersionMatch(current, version);
      case "<":
        return !compareVersions(current, version);
      case "<=":
        return !compareVersions(current, version) || isExactVersionMatch(current, version);
      default:
        return compareVersions(current, version);
    }
  });
}

/** `">=1.0.0 <2.0.0"` → `"大於等於 1.0.0 且 小於 2.0.0"`, for the error message. */
export function getVersionPrefixString(required: string): string {
  const prefixMap: Record<string, string> = {
    "=": "等於",
    ">": "大於",
    ">=": "大於等於",
    "<": "小於",
    "<=": "小於等於",
  };
  return parseRanges(required)
    .map(({ operator, version }) => `${prefixMap[operator] ?? "大於等於"} ${version}`)
    .join(" 且 ");
}
