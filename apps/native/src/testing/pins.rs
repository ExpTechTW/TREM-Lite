//! The map's data, pinned on real tiles: what a tile decodes to, the mesh it is cut into,
//! and the hillshade baked from its terrain. Any faster way of making them must make them
//! byte for byte the same.

use std::fmt::Write as _;

use sha2::{Digest, Sha256};

use super::check_golden;
use crate::map::{dem, mvt, tessellate};

fn tile(z: u8, x: u32, y: u32, kind: &str) -> Option<Vec<u8>> {
    let ext = if kind == "terrain" { "png" } else { "pbf" };
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("testdata")
        .join(kind)
        .join(format!("{z}/{x}/{y}.{ext}"));
    std::fs::read(path).ok().filter(|b| !b.is_empty())
}

fn digest(bytes: &[u8]) -> String {
    let hash = Sha256::digest(bytes);
    hash.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

pub const TILES: [(u32, u32); 6] = [(52, 27), (52, 28), (53, 27), (53, 28), (54, 27), (54, 28)];

#[test]
fn tiles_decode_cut_and_bake_as_pinned() {
    let mut out = String::new();
    for (x, y) in TILES {
        let _ = write!(out, "6/{x}/{y}:");
        match tile(6, x, y, "tiles") {
            None => out.push_str(" empty"),
            Some(bytes) => {
                let layers = mvt::decode(&bytes, "CODE").unwrap_or_default();
                for layer in &layers {
                    let parts: usize = layer.features.iter().map(|f| f.parts.len()).sum();
                    let _ = write!(out, " {}={}/{parts}", layer.name, layer.features.len());
                }
                match tessellate::tessellate(&bytes) {
                    Some(mesh) => {
                        let _ = write!(
                            out,
                            " | fill {}v {}i line {}v {}i spans {:?} {:?} {:?} {:?} {:?} | {} {} {} {}",
                            mesh.fill_vertices.len(),
                            mesh.fill_indices.len(),
                            mesh.line_vertices.len(),
                            mesh.line_indices.len(),
                            mesh.global,
                            mesh.city,
                            mesh.town,
                            mesh.town_line,
                            mesh.city_line,
                            digest(bytemuck::cast_slice(&mesh.fill_vertices)),
                            digest(bytemuck::cast_slice(&mesh.fill_indices)),
                            digest(bytemuck::cast_slice(&mesh.line_vertices)),
                            digest(bytemuck::cast_slice(&mesh.line_indices)),
                        );
                    }
                    None => out.push_str(" | no mesh"),
                }
            }
        }
        if let Some(png) = tile(6, x, y, "terrain") {
            let image = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
                .expect("terrain is a PNG")
                .into_rgb8();
            match dem::bake(image.as_raw(), image.width(), 6, y) {
                Some(baked) => {
                    let _ = write!(out, " | dem {} {}", baked.size, digest(&baked.pixels));
                }
                None => out.push_str(" | dem none"),
            }
        }
        out.push('\n');
    }
    check_golden("map_tiles", &out);
}
