//! `TREM_FIXTURE_DIR`: the HTTP layer reads files and never touches the network.
//!
//! * `.../api/v1/map/tiles/{z}/{x}/{y}.pbf` → `$DIR/tiles/{z}/{x}/{y}.pbf`
//! * `.../api/v1/map/terrain/{z}/{x}/{y}.png` → `$DIR/terrain/{z}/{x}/{y}.png`
//! * anything else → `$DIR/api/<host>/<path>`, with `?` written `__`; a path that
//!   is also a directory keeps its own answer in `<path>/__index`.
//!
//! A missing file is a 404, which is what the sparse tile pyramid answers too.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use super::Fetched;

fn dir() -> Option<&'static Path> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        std::env::var_os("TREM_FIXTURE_DIR")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    })
    .as_deref()
}

pub fn active() -> bool {
    dir().is_some()
}

/// The file an URL is answered from, relative to the fixture directory.
fn relative(url: &str) -> Option<PathBuf> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let (host, path) = rest.split_once('/')?;
    for (marker, folder) in [
        ("api/v1/map/tiles/", "tiles"),
        ("api/v1/map/terrain/", "terrain"),
    ] {
        if let Some(tile) = path.strip_prefix(marker) {
            return Some(Path::new(folder).join(tile));
        }
    }
    Some(
        Path::new("api")
            .join(host)
            .join(path.replace('?', "__").trim_end_matches('/')),
    )
}

pub fn read(url: &str) -> Result<Fetched, String> {
    let root = dir().ok_or("fixture mode is off")?;
    let rel = relative(url).ok_or_else(|| format!("bad url: {url}"))?;
    Ok(read_from(root, &rel))
}

fn read_from(root: &Path, rel: &Path) -> Fetched {
    let path = root.join(rel);
    let path = if path.is_dir() {
        path.join("__index")
    } else {
        path
    };
    let (status, body) = match std::fs::read(&path) {
        Ok(body) => (200, body),
        Err(_) => (404, Vec::new()),
    };
    Fetched {
        status,
        body: Arc::new(body),
        from_cache: false,
        stale: false,
        via: "離線資料",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_map_to_the_fixture_layout() {
        assert_eq!(
            relative("https://static.lb.exptech.dev/api/v1/map/tiles/7/107/55.pbf").unwrap(),
            Path::new("tiles/7/107/55.pbf")
        );
        assert_eq!(
            relative("https://static.lb.exptech.dev/api/v1/map/terrain/7/107/55.png").unwrap(),
            Path::new("terrain/7/107/55.png")
        );
        assert_eq!(
            relative("https://api.core.exptech.dev/api/v2/eq/report?limit=75").unwrap(),
            Path::new("api/api.core.exptech.dev/api/v2/eq/report__limit=75")
        );
    }

    #[test]
    fn a_directory_answers_from_its_index_and_a_miss_is_404() {
        let root = std::env::temp_dir().join(format!("trem-fixture-{}", std::process::id()));
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("a/b/__index"), b"index").unwrap();
        std::fs::write(root.join("a/c"), b"file").unwrap();
        assert_eq!(read_from(&root, Path::new("a/b")).body.as_slice(), b"index");
        assert_eq!(read_from(&root, Path::new("a/c")).body.as_slice(), b"file");
        assert_eq!(read_from(&root, Path::new("a/none")).status, 404);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
