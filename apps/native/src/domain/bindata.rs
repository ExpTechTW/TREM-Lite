//! Decoders for the compact binary data files of scripts/encode-data.mjs
//! (lib/bindata.ts): varints, little-endian f64s, length-prefixed UTF-8.

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn varint(&mut self) -> Option<u64> {
        let mut result = 0u64;
        let mut shift = 0;
        loop {
            let b = *self.buf.get(self.pos)?;
            self.pos += 1;
            result |= u64::from(b & 0x7f).checked_shl(shift).unwrap_or(0);
            shift += 7;
            if b & 0x80 == 0 {
                return Some(result);
            }
        }
    }

    fn f64(&mut self) -> Option<f64> {
        let bytes: [u8; 8] = self.buf.get(self.pos..self.pos + 8)?.try_into().ok()?;
        self.pos += 8;
        Some(f64::from_le_bytes(bytes))
    }

    fn str(&mut self) -> Option<String> {
        let len = self.varint()? as usize;
        let bytes = self.buf.get(self.pos..self.pos + len)?;
        self.pos += len;
        Some(String::from_utf8_lossy(bytes).into_owned())
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TimeTableRow {
    pub p: f64,
    pub s: f64,
    pub r: f64,
}

/// One depth's rows, in file order.
pub type TimeTable = Vec<(f64, Vec<TimeTableRow>)>;

pub fn decode_time_table(buf: &[u8]) -> Option<TimeTable> {
    let mut r = Reader { buf, pos: 0 };
    r.varint()?; // version
    let scale = r.varint()? as f64;
    let depths = r.varint()?;
    let mut table = Vec::with_capacity(depths as usize);
    for _ in 0..depths {
        let depth = r.varint()? as f64;
        let count = r.varint()? as usize;
        let mut columns = [vec![], vec![], vec![], vec![]];
        for column in &mut columns {
            column.reserve_exact(count);
            let mut prev = 0u64;
            for _ in 0..count {
                prev += r.varint()?;
                column.push(prev as f64 / scale);
            }
        }
        let rows = (0..count)
            .map(|j| TimeTableRow {
                p: columns[0][j],
                s: columns[1][j],
                r: columns[2][j],
            })
            .collect();
        table.push((depth, rows));
    }
    // `Object.keys` lists integer keys in ascending order, which decides ties.
    table.sort_by(|a: &(f64, Vec<TimeTableRow>), b| a.0.total_cmp(&b.0));
    Some(table)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Town {
    pub city: &'static str,
    pub town: &'static str,
    pub code: i32,
    pub lat: f64,
    pub lon: f64,
}

/// region.bin, flat. City names are shared: the table lives as long as the process.
pub fn decode_region(buf: &[u8]) -> Option<Vec<Town>> {
    let mut r = Reader { buf, pos: 0 };
    r.varint()?; // version
    let cities = r.varint()?;
    let mut out = Vec::new();
    for _ in 0..cities {
        let city: &'static str = Box::leak(r.str()?.into_boxed_str());
        let towns = r.varint()?;
        for _ in 0..towns {
            let town: &'static str = Box::leak(r.str()?.into_boxed_str());
            let code = r.varint()? as i32;
            let lat = r.f64()?;
            let lon = r.f64()?;
            out.push(Town {
                city,
                town,
                code,
                lat,
                lon,
            });
        }
    }
    Some(out)
}

#[derive(Clone, Debug, PartialEq)]
pub struct BoxFeature {
    pub id: u32,
    /// lon, lat.
    pub ring: Vec<[f64; 2]>,
}

pub fn decode_box(buf: &[u8]) -> Option<Vec<BoxFeature>> {
    let mut r = Reader { buf, pos: 0 };
    r.varint()?; // version
    let scale = r.varint()? as f64;
    let count = r.varint()?;
    let mut out = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let id = r.varint()? as u32;
        let n = r.varint()? as usize;
        let mut ring = Vec::with_capacity(n);
        for _ in 0..n {
            let lon = r.varint()? as f64 / scale;
            let lat = r.varint()? as f64 / scale;
            ring.push([lon, lat]);
        }
        out.push(BoxFeature { id, ring });
    }
    Some(out)
}
