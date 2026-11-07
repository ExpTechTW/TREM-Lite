//! What an app's tests need from here: text and pictures compared with the golden files
//! the app keeps, wherever it keeps them, and a GPU where pictures can be checked.

use std::path::Path;

use crate::render::Gpu;

/// Compare with the golden file at `path`; `UPDATE_GOLDEN=1` writes it instead. A failure
/// is named after the file.
pub fn check_golden(path: &Path, actual: &str) {
    let name = name_of(path);
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))
            .expect("the golden directory");
        std::fs::write(path, actual).expect("the golden file");
        return;
    }
    let expected = std::fs::read_to_string(path).unwrap_or_else(|_| {
        panic!(
            "no golden file {}: run with UPDATE_GOLDEN=1",
            path.display()
        )
    });
    if expected != actual {
        let first = expected
            .lines()
            .zip(actual.lines())
            .position(|(a, b)| a != b)
            .unwrap_or_else(|| expected.lines().count().min(actual.lines().count()));
        let near = |text: &str| {
            text.lines()
                .skip(first.saturating_sub(2))
                .take(6)
                .collect::<Vec<_>>()
                .join("\n")
        };
        panic!(
            "{name} differs from its golden file at line {}:\n--- expected\n{}\n--- actual\n{}",
            first + 1,
            near(&expected),
            near(actual)
        );
    }
}

/// Compare with the golden picture at `path`; `UPDATE_GOLDEN=1` writes it instead.
/// A pixel counts as different past 16 in a channel; at most 0.1% may be. A failing
/// frame is left in the temporary directory, named after the picture.
pub fn check_picture(path: &Path, width: u32, height: u32, rgba: Vec<u8>) {
    let name = name_of(path);
    let actual = image::RgbaImage::from_raw(width, height, rgba).expect("pixels for the size");
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("the golden directory");
        actual.save(path).expect("the golden picture");
        return;
    }
    let expected = image::open(path)
        .unwrap_or_else(|_| {
            panic!(
                "no golden picture {}: run with UPDATE_GOLDEN=1",
                path.display()
            )
        })
        .into_rgba8();
    assert_eq!(expected.dimensions(), actual.dimensions(), "{name}: size");
    let differ = expected
        .pixels()
        .zip(actual.pixels())
        .filter(|(a, b)| a.0.iter().zip(b.0.iter()).any(|(x, y)| x.abs_diff(*y) > 16))
        .count();
    let share = differ as f64 / f64::from(width * height);
    if share > 0.001 {
        let out = std::env::temp_dir().join(format!("{name}-actual.png"));
        let _ = actual.save(&out);
        panic!(
            "{name}: {:.3}% of pixels differ from the golden picture; this frame is at {}",
            share * 100.0,
            out.display()
        );
    }
}

/// The pictures are checked on a Mac like the one they were drawn on; elsewhere, and where
/// `TREM_SKIP_PICTURES` is set (CI's runners), they are not.
pub fn gpu() -> Option<Gpu> {
    if !cfg!(target_os = "macos") || std::env::var_os("TREM_SKIP_PICTURES").is_some() {
        return None;
    }
    let gpu = Gpu::new();
    if gpu.is_none() {
        eprintln!("no GPU: the pictures are not checked");
    }
    gpu
}

/// A golden file's name, as a failure gives it: its file name without the extension.
fn name_of(path: &Path) -> String {
    path.file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default()
}
