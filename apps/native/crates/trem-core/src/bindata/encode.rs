//! The encoders of the data this crate embeds (assets/data/*.bin), from the JSON beside
//! it. The test `encoded_data` fails when a .bin and its .json disagree; `UPDATE_GOLDEN=1`
//! writes the .bin files instead. An encoder panics on JSON its format cannot hold: it is
//! a build step, not something to run on live data. The formats, all little-endian,
//! varint = unsigned LEB128:
//!
//! - time.bin: version | scale (1000) | depths; per depth: key | rows | the P, S, R and D
//!   columns, each rows delta-varints of round(v * scale) (monotonic, so never negative).
//! - region.bin: version | cities; per city: name | towns; per town: name | code (varint)
//!   | lat (f64) | lon (f64). The site and area fields are left out: nothing reads them.
//! - box.bin: version | scale (100) | features; per feature: ID | points | lon, lat
//!   varints of round(coord * scale) (Taiwan's coordinates are positive, two decimals).

use serde::de::{Deserialize, Deserializer, MapAccess, Visitor};
use serde_json::Value;

/// A JSON object's members in the order JavaScript gives them: keys that are array
/// indices first, ascending, then the rest as written. The data was first encoded by
/// JavaScript, and its order is part of the format. Read from the JSON text: a `Value`
/// would keep its objects sorted.
struct Members<T>(Vec<(String, T)>);

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Members<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Collect<T>(std::marker::PhantomData<T>);
        impl<'de, T: Deserialize<'de>> Visitor<'de> for Collect<T> {
            type Value = Members<T>;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a JSON object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Members<T>, A::Error> {
                let mut members = Vec::new();
                while let Some(entry) = map.next_entry::<String, T>()? {
                    members.push(entry);
                }
                let index = |key: &str| {
                    (key == "0" || !key.starts_with('0'))
                        .then(|| key.parse::<u32>().ok())
                        .flatten()
                };
                let (mut indices, rest): (Vec<_>, Vec<_>) = members
                    .into_iter()
                    .partition(|(key, _)| index(key).is_some());
                indices.sort_by_key(|(key, _)| index(key));
                indices.extend(rest);
                Ok(Members(indices))
            }
        }
        deserializer.deserialize_map(Collect(std::marker::PhantomData))
    }
}

fn varint(out: &mut Vec<u8>, mut n: u64) {
    while n > 0x7f {
        out.push((n & 0x7f) as u8 | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
}

fn text(out: &mut Vec<u8>, s: &str) {
    varint(out, s.len() as u64);
    out.extend_from_slice(s.as_bytes());
}

/// `round(v * scale)`, which must give `v` back exactly.
fn scaled(v: f64, scale: f64, what: &str) -> u64 {
    let i = (v * scale).round();
    assert!(
        i >= 0.0 && i / scale == v,
        "{what}: {v} is not exact at {scale}"
    );
    i as u64
}

fn num(value: &Value, what: &str) -> f64 {
    value
        .as_f64()
        .unwrap_or_else(|| panic!("{what}: not a number"))
}

pub fn encode_time(json: &[u8]) -> Vec<u8> {
    const SCALE: f64 = 1000.0;
    let depths: Members<Vec<Value>> = serde_json::from_slice(json).expect("time.json");
    let depths = depths.0;
    let mut out = Vec::new();
    varint(&mut out, 1);
    varint(&mut out, SCALE as u64);
    varint(&mut out, depths.len() as u64);
    for (depth, rows) in &depths {
        varint(&mut out, depth.parse().expect("a depth"));
        varint(&mut out, rows.len() as u64);
        for column in ["P", "S", "R", "D"] {
            let mut previous = 0;
            for row in rows {
                let at = format!("time {depth} {column}");
                let value = scaled(num(&row[column], &at), SCALE, &at);
                assert!(value >= previous, "{at}: not monotonic");
                varint(&mut out, value - previous);
                previous = value;
            }
        }
    }
    out
}

pub fn encode_region(json: &[u8]) -> Vec<u8> {
    let cities: Members<Members<Value>> = serde_json::from_slice(json).expect("region.json");
    let cities = cities.0;
    let mut out = Vec::new();
    varint(&mut out, 1);
    varint(&mut out, cities.len() as u64);
    for (city, towns) in &cities {
        text(&mut out, city);
        varint(&mut out, towns.0.len() as u64);
        for (town, info) in &towns.0 {
            text(&mut out, town);
            varint(&mut out, info["code"].as_u64().expect("a town code"));
            out.extend_from_slice(&num(&info["lat"], town).to_le_bytes());
            out.extend_from_slice(&num(&info["lon"], town).to_le_bytes());
        }
    }
    out
}

pub fn encode_box(json: &[u8]) -> Vec<u8> {
    const SCALE: f64 = 100.0;
    let json: Value = serde_json::from_slice(json).expect("box.json");
    let features = json["features"].as_array().expect("features");
    let mut out = Vec::new();
    varint(&mut out, 1);
    varint(&mut out, SCALE as u64);
    varint(&mut out, features.len() as u64);
    for feature in features {
        varint(
            &mut out,
            feature["properties"]["ID"].as_u64().expect("an ID"),
        );
        // One ring a feature, checked when the format was made.
        let ring = feature["geometry"]["coordinates"][0]
            .as_array()
            .expect("a ring");
        varint(&mut out, ring.len() as u64);
        for point in ring {
            varint(
                &mut out,
                scaled(num(&point[0], "box lon"), SCALE, "box lon"),
            );
            varint(
                &mut out,
                scaled(num(&point[1], "box lat"), SCALE, "box lat"),
            );
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    /// A file's JSON in, its .bin out.
    type Encoder = fn(&[u8]) -> Vec<u8>;

    #[test]
    fn encoded_data() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets/data");
        let encoders: [(&str, Encoder); 3] = [
            ("time", encode_time),
            ("region", encode_region),
            ("box", encode_box),
        ];
        for (name, encode) in encoders {
            let json = std::fs::read(dir.join(format!("{name}.json"))).expect("the JSON");
            let encoded = encode(&json);
            let bin = dir.join(format!("{name}.bin"));
            if std::env::var_os("UPDATE_GOLDEN").is_some() {
                std::fs::write(&bin, &encoded).expect("the .bin");
                continue;
            }
            let stored = std::fs::read(&bin).expect("the .bin");
            assert!(
                stored == encoded,
                "{name}.bin is not {name}.json encoded: run with UPDATE_GOLDEN=1"
            );
        }
    }
}
