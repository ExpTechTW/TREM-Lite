//! The name a build goes by — tool/release/version.sh's `label` — read back
//! from the semver it was stamped with (packages/core/src/lib/version.ts is
//! the same rule for the webview):
//!
//!   26.1.0         → 26.1     a release
//!   26.1.2         → 26.1.2   a patch release
//!   26.1.0-26w40a  → 26w40a   a snapshot: a pre-release of the train it precedes
//!
//! The semver is for the updater, which orders builds by it; people see only
//! the label. A snapshot's train is never shown: 26.1 and 26w40a name
//! different builds, and one must not read as the other.

pub fn label(version: &str) -> String {
    let version = version.trim();
    let core = version.split('+').next().unwrap_or(version);
    let (core, pre) = match core.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (core, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    let numeric = parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    if !numeric {
        return version.to_string();
    }
    match pre {
        Some(pre) if !pre.is_empty() => pre.to_string(),
        _ if parts[2] == "0" => format!("{}.{}", parts[0], parts[1]),
        _ => core.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::label;

    #[test]
    fn a_release_drops_a_zero_patch() {
        assert_eq!(label("26.1.0"), "26.1");
        assert_eq!(label("27.3.0"), "27.3");
    }

    #[test]
    fn a_patch_release_keeps_its_patch() {
        assert_eq!(label("26.1.2"), "26.1.2");
    }

    #[test]
    fn a_snapshot_shows_only_its_own_name() {
        assert_eq!(label("26.1.0-26w40a"), "26w40a");
        assert_eq!(label("27.1.0-27w01b"), "27w01b");
        assert_eq!(label("26.2.0-26w52aa+build.7"), "26w52aa");
    }

    #[test]
    fn anything_else_is_shown_as_it_is() {
        assert_eq!(label("26w40a"), "26w40a");
        assert_eq!(label("26.1"), "26.1");
        assert_eq!(label("dev"), "dev");
    }
}
