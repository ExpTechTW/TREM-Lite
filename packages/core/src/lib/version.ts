/**
 * The name a build goes by — tool/release/version.sh's `label` — read back from
 * the semver it was stamped with, which is what Tauri reports:
 *
 *   26.1.0         → 26.1     a release
 *   26.1.2         → 26.1.2   a patch release
 *   26.1.0-26w40a  → 26w40a   a snapshot: a pre-release of the train it precedes
 *
 * The semver is for the updater, which orders builds by it; people see only
 * the label. A snapshot's train is never shown: 26.1 and 26w40a name different
 * builds, and one must not read as the other. Anything else is shown as it is.
 */
export function versionLabel(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!m) return version;
  const [, major, minor, patch, pre] = m;
  if (pre) return pre;
  return patch === "0" ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
}
