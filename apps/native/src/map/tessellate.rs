//! A basemap tile cut into triangles, once, on a worker. After this the tile lives
//! on the GPU and only the camera moves it.

use bytemuck::{Pod, Zeroable};

use super::mvt::{self, GeomType};

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct FillVertex {
    pub x: i16,
    pub y: i16,
    /// The town's code, which indexes the colour lookup; 0 elsewhere.
    pub code: u16,
    pub _pad: u16,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct LineVertex {
    pub x: i16,
    pub y: i16,
    /// The extrusion direction at 1/64: a miter is longer than 1.
    pub nx: i8,
    pub ny: i8,
    /// Which side of the line: -1 or 1.
    pub side: i8,
    pub _pad: i8,
}

/// Longest miter, in line half-widths, before a join is bevelled instead.
const MITER_LIMIT: f32 = 2.0;
const NORMAL_SCALE: f32 = 64.0;

/// Index ranges of one tile's layers within its index buffer.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Span {
    pub start: u32,
    pub count: u32,
}

#[derive(Debug, Default)]
pub struct TileMesh {
    pub extent: u32,
    pub fill_vertices: Vec<FillVertex>,
    pub fill_indices: Vec<u32>,
    pub global: Span,
    pub city: Span,
    pub town: Span,
    pub line_vertices: Vec<LineVertex>,
    pub line_indices: Vec<u32>,
    pub town_line: Span,
    pub city_line: Span,
}

impl TileMesh {
    pub fn gpu_bytes(&self) -> u64 {
        (self.fill_vertices.len() * std::mem::size_of::<FillVertex>()
            + self.fill_indices.len() * 4
            + self.line_vertices.len() * std::mem::size_of::<LineVertex>()
            + self.line_indices.len() * 4) as u64
    }
}

/// The signed area of a ring; in MVT's y-down space an exterior ring is positive.
fn ring_area(ring: &[(i16, i16)]) -> f64 {
    let mut sum = 0.0;
    for w in ring.windows(2) {
        sum += f64::from(w[0].0) * f64::from(w[1].1) - f64::from(w[1].0) * f64::from(w[0].1);
    }
    sum
}

/// One polygon: an exterior ring and the holes that follow it, as MVT 2.1 orders them.
fn fill_polygon(rings: &[&Vec<(i16, i16)>], code: u16, mesh: &mut TileMesh) {
    let mut flat: Vec<f64> = Vec::new();
    let mut holes: Vec<usize> = Vec::new();
    let base = mesh.fill_vertices.len() as u32;
    for (n, ring) in rings.iter().enumerate() {
        if n > 0 {
            holes.push(flat.len() / 2);
        }
        // The ring closes on its first point; earcut wants it once.
        let open = ring
            .split_last()
            .filter(|(last, rest)| rest.first() == Some(last))
            .map_or(ring.as_slice(), |(_, rest)| rest);
        for &(x, y) in open {
            flat.push(f64::from(x));
            flat.push(f64::from(y));
            mesh.fill_vertices.push(FillVertex {
                x,
                y,
                code,
                _pad: 0,
            });
        }
    }
    match earcutr::earcut(&flat, &holes, 2) {
        Ok(triangles) => mesh
            .fill_indices
            .extend(triangles.into_iter().map(|i| base + i as u32)),
        Err(e) => log::debug!("圖磚多邊形切不開：{e:?}"),
    }
}

fn fill_layer(layer: &mvt::Layer, mesh: &mut TileMesh, use_code: bool) -> Span {
    let start = mesh.fill_indices.len() as u32;
    for feature in &layer.features {
        if feature.kind != GeomType::Polygon {
            continue;
        }
        let code = if use_code {
            feature.code.unwrap_or(0).min(u32::from(u16::MAX)) as u16
        } else {
            0
        };
        let mut rings: Vec<&Vec<(i16, i16)>> = Vec::new();
        for part in &feature.parts {
            if part.len() < 3 {
                continue;
            }
            if ring_area(part) > 0.0 && !rings.is_empty() {
                fill_polygon(&rings, code, mesh);
                rings.clear();
            }
            rings.push(part);
        }
        if !rings.is_empty() {
            fill_polygon(&rings, code, mesh);
        }
    }
    Span {
        start,
        count: mesh.fill_indices.len() as u32 - start,
    }
}

/// Unit normal of a segment, pointing left of its direction in y-down space.
fn normal(a: (f32, f32), b: (f32, f32)) -> Option<(f32, f32)> {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len = dx.hypot(dy);
    if len < 1e-6 {
        return None;
    }
    Some((-dy / len, dx / len))
}

fn push_pair(mesh: &mut TileMesh, x: i16, y: i16, n: (f32, f32)) -> u32 {
    let at = mesh.line_vertices.len() as u32;
    let nx = (n.0 * NORMAL_SCALE).round().clamp(-127.0, 127.0) as i8;
    let ny = (n.1 * NORMAL_SCALE).round().clamp(-127.0, 127.0) as i8;
    mesh.line_vertices.push(LineVertex {
        x,
        y,
        nx,
        ny,
        side: 1,
        _pad: 0,
    });
    mesh.line_vertices.push(LineVertex {
        x,
        y,
        nx: -nx,
        ny: -ny,
        side: -1,
        _pad: 0,
    });
    at
}

/// A polyline extruded into a strip of quads, with miter joins up to MITER_LIMIT and
/// a bevel beyond it. The width is the shader's: it can change without retiling.
pub fn stroke(
    points: &[(i16, i16)],
    closed: bool,
    skip_edge: impl Fn((i16, i16), (i16, i16)) -> bool,
    mesh: &mut TileMesh,
) {
    let mut run: Vec<(i16, i16)> = Vec::with_capacity(points.len());
    let flush = |run: &mut Vec<(i16, i16)>, closed: bool, mesh: &mut TileMesh| {
        if run.len() >= 2 {
            stroke_run(run, closed, mesh);
        }
        run.clear();
    };
    let mut any_skipped = false;
    for pair in points.windows(2) {
        if skip_edge(pair[0], pair[1]) {
            any_skipped = true;
            flush(&mut run, false, mesh);
            continue;
        }
        if run.is_empty() {
            run.push(pair[0]);
        }
        run.push(pair[1]);
    }
    flush(&mut run, closed && !any_skipped, mesh);
}

fn stroke_run(points: &[(i16, i16)], closed: bool, mesh: &mut TileMesh) {
    let pts: Vec<(f32, f32)> = points.iter().map(|&(x, y)| (x as f32, y as f32)).collect();
    let count = if closed && pts.first() == pts.last() {
        pts.len() - 1
    } else {
        pts.len()
    };
    if count < 2 {
        return;
    }
    let at = |i: isize| -> (f32, f32) {
        let n = count as isize;
        pts[i.rem_euclid(n) as usize]
    };
    let mut prev_end: Option<u32> = None;
    let mut first_start: Option<u32> = None;
    let segments = if closed { count } else { count - 1 };
    for s in 0..segments {
        let a_i = s as isize;
        let b_i = a_i + 1;
        let (a, b) = (at(a_i), at(b_i));
        let Some(n) = normal(a, b) else {
            continue;
        };
        // Join at a with the segment before it, at b with the one after.
        let prev = if closed || s > 0 {
            normal(at(a_i - 1), a)
        } else {
            None
        };
        let next = if closed || s + 1 < segments {
            normal(b, at(b_i + 1))
        } else {
            None
        };
        let (start_n, start_bevel) = join(prev, n);
        let (end_n, _) = join(Some(n), next.unwrap_or(n));
        let (ax, ay) = (a.0 as i16, a.1 as i16);
        let (bx, by) = (b.0 as i16, b.1 as i16);
        let start = push_pair(mesh, ax, ay, start_n);
        let end = push_pair(mesh, bx, by, end_n);
        mesh.line_indices
            .extend_from_slice(&[start, start + 1, end, end, start + 1, end + 1]);
        // A miter meets exactly; a bevel leaves a gap to close.
        if let (Some(pe), true) = (prev_end, start_bevel) {
            mesh.line_indices
                .extend_from_slice(&[pe, pe + 1, start, start, pe + 1, start + 1]);
        }
        first_start.get_or_insert(start);
        prev_end = Some(end);
    }
    if let (true, Some(first), Some(last)) = (closed, first_start, prev_end) {
        mesh.line_indices
            .extend_from_slice(&[last, last + 1, first, first, last + 1, first + 1]);
    }
}

/// The extrusion where two segments meet. The second value says it is a bevel.
fn join(before: Option<(f32, f32)>, after: (f32, f32)) -> ((f32, f32), bool) {
    let Some(before) = before else {
        return (after, false);
    };
    let sum = (before.0 + after.0, before.1 + after.1);
    let len = sum.0.hypot(sum.1);
    if len < 1e-3 {
        return (after, true);
    }
    let unit = (sum.0 / len, sum.1 / len);
    // 1 / cos(half the turn) is how far the miter reaches.
    let cos = unit.0 * after.0 + unit.1 * after.1;
    let miter = if cos > 1e-3 { 1.0 / cos } else { f32::MAX };
    if miter > MITER_LIMIT {
        return (after, true);
    }
    ((unit.0 * miter, unit.1 * miter), false)
}

fn line_layer(layer: &mvt::Layer, extent: i16, mesh: &mut TileMesh) -> Span {
    let start = mesh.line_indices.len() as u32;
    // An edge that runs along the tile's own boundary is where the polygon was cut,
    // not where it ends: it must not draw a line.
    let on_edge = move |a: (i16, i16), b: (i16, i16)| {
        (a.0 <= 0 && b.0 <= 0)
            || (a.1 <= 0 && b.1 <= 0)
            || (a.0 >= extent && b.0 >= extent)
            || (a.1 >= extent && b.1 >= extent)
    };
    for feature in &layer.features {
        if feature.kind == GeomType::Point {
            continue;
        }
        let closed = feature.kind == GeomType::Polygon;
        for part in &feature.parts {
            stroke(part, closed, on_edge, mesh);
        }
    }
    Span {
        start,
        count: mesh.line_indices.len() as u32 - start,
    }
}

/// Decode and cut one basemap tile. None when the bytes are not a tile.
pub fn tessellate(bytes: &[u8]) -> Option<TileMesh> {
    let layers = mvt::decode(bytes, "CODE")?;
    let mut mesh = TileMesh {
        extent: layers.first().map_or(4096, |l| l.extent),
        ..TileMesh::default()
    };
    let find = |name: &str| layers.iter().find(|l| l.name == name);
    if let Some(layer) = find("global") {
        mesh.global = fill_layer(layer, &mut mesh, false);
    }
    if let Some(layer) = find("city") {
        mesh.city = fill_layer(layer, &mut mesh, false);
    }
    if let Some(layer) = find("town") {
        mesh.town = fill_layer(layer, &mut mesh, true);
    }
    let extent = mesh.extent.min(16384) as i16;
    if let Some(layer) = find("town") {
        mesh.town_line = line_layer(layer, extent, &mut mesh);
    }
    if let Some(layer) = find("city") {
        mesh.city_line = line_layer(layer, extent, &mut mesh);
    }
    Some(mesh)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_square_town_gives_two_triangles_and_a_closed_outline() {
        let mesh = tessellate(&mvt::testing::sample_tile()).unwrap();
        assert_eq!(mesh.town.count, 6);
        assert_eq!(mesh.fill_vertices.len(), 4);
        assert!(mesh.fill_vertices.iter().all(|v| v.code == 962));
        // Four sides, two triangles each, plus nothing at a square's miters.
        assert!(mesh.town_line.count >= 24);
        assert_eq!(mesh.line_vertices.len() % 2, 0);
        assert!(mesh.gpu_bytes() > 0);
    }

    #[test]
    fn an_edge_along_the_tile_boundary_draws_nothing() {
        let mut mesh = TileMesh::default();
        let on = |a: (i16, i16), b: (i16, i16)| a.0 <= 0 && b.0 <= 0;
        stroke(&[(0, 0), (0, 100), (100, 100)], false, on, &mut mesh);
        // Only the second segment remains.
        assert_eq!(mesh.line_indices.len(), 6);
    }

    #[test]
    fn a_sharp_corner_is_bevelled_and_a_gentle_one_mitered() {
        let (n, bevel) = join(Some((1.0, 0.0)), (0.0, 1.0));
        assert!(!bevel);
        assert!((n.0.hypot(n.1) - std::f32::consts::SQRT_2).abs() < 1e-3);
        // Nearly doubling back: the miter would reach far past the limit.
        let (_, bevel) = join(Some((1.0, 0.0)), (-0.99, 0.14));
        assert!(bevel);
    }

    #[test]
    fn garbage_gives_no_mesh() {
        assert!(tessellate(&[0xff, 0xff]).is_none());
    }
}
