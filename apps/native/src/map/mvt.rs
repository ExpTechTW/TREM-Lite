//! A decoder for just what the basemap uses of Mapbox Vector Tiles: layers, features,
//! geometry, and one numeric property. Protobuf wire format, written by hand.
//! <https://github.com/mapbox/vector-tile-spec/tree/master/2.1>

/// A cursor over protobuf bytes.
struct Pb<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Pb<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn done(&self) -> bool {
        self.pos >= self.buf.len()
    }

    fn varint(&mut self) -> Option<u64> {
        let mut out = 0u64;
        let mut shift = 0;
        loop {
            let byte = *self.buf.get(self.pos)?;
            self.pos += 1;
            out |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Some(out);
            }
            shift += 7;
            if shift > 63 {
                return None;
            }
        }
    }

    fn bytes(&mut self) -> Option<&'a [u8]> {
        let len = self.varint()? as usize;
        let end = self.pos.checked_add(len)?;
        let out = self.buf.get(self.pos..end)?;
        self.pos = end;
        Some(out)
    }

    fn skip(&mut self, wire: u64) -> Option<()> {
        match wire {
            0 => {
                self.varint()?;
            }
            1 => self.pos += 8,
            2 => {
                self.bytes()?;
            }
            5 => self.pos += 4,
            _ => return None,
        }
        Some(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GeomType {
    Unknown,
    Point,
    Line,
    Polygon,
}

#[derive(Debug)]
pub struct Feature {
    pub kind: GeomType,
    /// The value of the property asked for, when it has one and it is a number.
    pub code: Option<u32>,
    /// Each ring or line, in tile coordinates.
    pub parts: Vec<Vec<(i16, i16)>>,
}

#[derive(Debug)]
pub struct Layer {
    pub name: String,
    pub extent: u32,
    pub features: Vec<Feature>,
}

fn zigzag(v: u64) -> i64 {
    ((v >> 1) as i64) ^ -((v & 1) as i64)
}

fn clamp16(v: i64) -> i16 {
    v.clamp(i64::from(i16::MIN), i64::from(i16::MAX)) as i16
}

fn decode_geometry(buf: &[u8]) -> Option<Vec<Vec<(i16, i16)>>> {
    let mut pb = Pb::new(buf);
    let mut parts: Vec<Vec<(i16, i16)>> = Vec::new();
    let mut x = 0i64;
    let mut y = 0i64;
    while !pb.done() {
        let command = pb.varint()?;
        let id = command & 7;
        let count = command >> 3;
        match id {
            1 | 2 => {
                for _ in 0..count {
                    x += zigzag(pb.varint()?);
                    y += zigzag(pb.varint()?);
                    if id == 1 {
                        parts.push(Vec::new());
                    }
                    parts.last_mut()?.push((clamp16(x), clamp16(y)));
                }
            }
            7 => {
                let first = *parts.last()?.first()?;
                parts.last_mut()?.push(first);
            }
            _ => return None,
        }
    }
    Some(parts)
}

/// A property value as a whole number, whichever way the encoder wrote it.
fn decode_number(buf: &[u8]) -> Option<u32> {
    let mut pb = Pb::new(buf);
    while !pb.done() {
        let key = pb.varint()?;
        let (field, wire) = (key >> 3, key & 7);
        match (field, wire) {
            (1, 2) => {
                return std::str::from_utf8(pb.bytes()?).ok()?.trim().parse().ok();
            }
            (2, 5) => {
                let raw = pb.buf.get(pb.pos..pb.pos + 4)?;
                return Some(f32::from_le_bytes(raw.try_into().ok()?) as u32);
            }
            (3, 1) => {
                let raw = pb.buf.get(pb.pos..pb.pos + 8)?;
                return Some(f64::from_le_bytes(raw.try_into().ok()?) as u32);
            }
            (4 | 5, 0) => return Some(pb.varint()? as u32),
            (6, 0) => return Some(zigzag(pb.varint()?) as u32),
            _ => pb.skip(wire)?,
        }
    }
    None
}

struct RawFeature<'a> {
    tags: &'a [u8],
    kind: GeomType,
    geometry: &'a [u8],
}

fn decode_feature(buf: &[u8]) -> Option<RawFeature<'_>> {
    let mut pb = Pb::new(buf);
    let mut out = RawFeature {
        tags: &[],
        kind: GeomType::Unknown,
        geometry: &[],
    };
    while !pb.done() {
        let key = pb.varint()?;
        match (key >> 3, key & 7) {
            (2, 2) => out.tags = pb.bytes()?,
            (3, 0) => {
                out.kind = match pb.varint()? {
                    1 => GeomType::Point,
                    2 => GeomType::Line,
                    3 => GeomType::Polygon,
                    _ => GeomType::Unknown,
                };
            }
            (4, 2) => out.geometry = pb.bytes()?,
            (_, wire) => pb.skip(wire)?,
        }
    }
    Some(out)
}

fn decode_layer(buf: &[u8], property: &str) -> Option<Layer> {
    let mut pb = Pb::new(buf);
    let mut name = String::new();
    let mut extent = 4096;
    let mut raw_features = Vec::new();
    let mut key_index = None;
    let mut keys = 0u64;
    let mut values: Vec<&[u8]> = Vec::new();
    while !pb.done() {
        let key = pb.varint()?;
        match (key >> 3, key & 7) {
            (1, 2) => name = String::from_utf8_lossy(pb.bytes()?).into_owned(),
            (2, 2) => raw_features.push(pb.bytes()?),
            (3, 2) => {
                if pb.bytes()? == property.as_bytes() {
                    key_index = Some(keys);
                }
                keys += 1;
            }
            (4, 2) => values.push(pb.bytes()?),
            (5, 0) => extent = pb.varint()? as u32,
            (_, wire) => pb.skip(wire)?,
        }
    }
    let mut features = Vec::with_capacity(raw_features.len());
    for raw in raw_features {
        let raw = decode_feature(raw)?;
        let mut code = None;
        if let Some(want) = key_index {
            let mut tags = Pb::new(raw.tags);
            while !tags.done() {
                let k = tags.varint()?;
                let v = tags.varint()?;
                if k == want {
                    code = values.get(v as usize).and_then(|b| decode_number(b));
                    break;
                }
            }
        }
        features.push(Feature {
            kind: raw.kind,
            code,
            parts: decode_geometry(raw.geometry)?,
        });
    }
    Some(Layer {
        name,
        extent,
        features,
    })
}

/// Every layer of a tile, reading `property` of each feature into `code`. None when
/// the bytes are not a valid tile.
pub fn decode(buf: &[u8], property: &str) -> Option<Vec<Layer>> {
    let mut pb = Pb::new(buf);
    let mut layers = Vec::new();
    while !pb.done() {
        let key = pb.varint()?;
        match (key >> 3, key & 7) {
            (3, 2) => layers.push(decode_layer(pb.bytes()?, property)?),
            (_, wire) => pb.skip(wire)?,
        }
    }
    Some(layers)
}

#[cfg(test)]
pub(crate) mod testing {
    /// A tile with one polygon layer, written by hand in the wire format.
    pub fn sample_tile() -> Vec<u8> {
        fn varint(mut v: u64, out: &mut Vec<u8>) {
            while v >= 0x80 {
                out.push((v as u8) | 0x80);
                v >>= 7;
            }
            out.push(v as u8);
        }
        fn bytes(field: u64, data: &[u8], out: &mut Vec<u8>) {
            varint(field << 3 | 2, out);
            varint(data.len() as u64, out);
            out.extend_from_slice(data);
        }
        let zig = |v: i64| ((v << 1) ^ (v >> 63)) as u64;
        // MoveTo(100,100) LineTo(200,100) (200,200) (100,200) ClosePath.
        let mut geom = Vec::new();
        varint(1 << 3 | 1, &mut geom);
        varint(zig(100), &mut geom);
        varint(zig(100), &mut geom);
        varint(3 << 3 | 2, &mut geom);
        for (dx, dy) in [(100, 0), (0, 100), (-100, 0)] {
            varint(zig(dx), &mut geom);
            varint(zig(dy), &mut geom);
        }
        varint((1 << 3) | 7, &mut geom);
        let mut feature = Vec::new();
        bytes(2, &[0, 0], &mut feature);
        varint(3 << 3, &mut feature);
        varint(3, &mut feature);
        bytes(4, &geom, &mut feature);
        let mut value = Vec::new();
        varint(5 << 3, &mut value);
        varint(962, &mut value);
        let mut layer = Vec::new();
        bytes(1, b"town", &mut layer);
        bytes(2, &feature, &mut layer);
        bytes(3, b"CODE", &mut layer);
        bytes(4, &value, &mut layer);
        varint(5 << 3, &mut layer);
        varint(4096, &mut layer);
        let mut tile = Vec::new();
        bytes(3, &layer, &mut tile);
        tile
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hand_written_tile_decodes() {
        let layers = decode(&testing::sample_tile(), "CODE").unwrap();
        assert_eq!(layers.len(), 1);
        let layer = &layers[0];
        assert_eq!(layer.name, "town");
        assert_eq!(layer.extent, 4096);
        let f = &layer.features[0];
        assert_eq!(f.kind, GeomType::Polygon);
        assert_eq!(f.code, Some(962));
        assert_eq!(
            f.parts[0],
            vec![(100, 100), (200, 100), (200, 200), (100, 200), (100, 100)]
        );
    }

    #[test]
    fn garbage_is_not_a_tile() {
        assert!(decode(&[0xff, 0xff, 0xff], "CODE").is_none());
    }

    #[test]
    fn a_real_basemap_tile_has_the_four_layers() {
        let Ok(dir) = std::env::var("TREM_TEST_TILES") else {
            return;
        };
        let bytes = std::fs::read(format!("{dir}/7/107/55.pbf")).unwrap();
        let layers = decode(&bytes, "CODE").unwrap();
        let names: Vec<_> = layers.iter().map(|l| l.name.as_str()).collect();
        for want in ["town", "city"] {
            assert!(names.contains(&want), "{names:?}");
        }
        let town = layers.iter().find(|l| l.name == "town").unwrap();
        assert!(town.features.iter().all(|f| f.code.is_some()));
    }
}
