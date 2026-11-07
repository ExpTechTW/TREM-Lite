//! The domain's data, parsed tolerantly from what the ExpTech API sends (lib/types.ts).
//! Numbers may arrive as strings and any field may be missing; a bad value becomes the
//! default rather than dropping the whole frame.

use std::collections::HashMap;
use std::sync::Arc;

use serde::de::{Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;
use serde_json::Value;

/// A station's id: 7 or 8 ASCII characters, hex for rts.v1 and decimal for the older
/// network. Copy, so a frame of a thousand stations allocates no strings.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, PartialOrd, Ord, Default)]
pub struct StationId([u8; 8]);

impl StationId {
    pub fn new(id: &str) -> Option<Self> {
        let bytes = id.as_bytes();
        if bytes.is_empty() || bytes.len() > 8 {
            return None;
        }
        let mut out = [0; 8];
        out[..bytes.len()].copy_from_slice(bytes);
        Some(Self(out))
    }

    pub fn as_str(&self) -> &str {
        let len = self.0.iter().position(|b| *b == 0).unwrap_or(8);
        std::str::from_utf8(&self.0[..len]).unwrap_or("")
    }
}

impl std::fmt::Display for StationId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Number, numeric string, or anything else (NaN).
fn lenient(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => s.trim().parse().unwrap_or(f64::NAN),
        Value::Bool(b) => f64::from(u8::from(*b)),
        _ => f64::NAN,
    }
}

fn de_f64<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    let v = Value::deserialize(d)?;
    let n = lenient(&v);
    Ok(if n.is_nan() { 0.0 } else { n })
}

fn de_i32<'de, D: Deserializer<'de>>(d: D) -> Result<i32, D::Error> {
    Ok(de_f64(d)? as i32)
}

fn de_i64<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    Ok(de_f64(d)? as i64)
}

fn de_string<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) => s,
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    })
}

fn de_truthy<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Bool(b) => b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Null => false,
        _ => true,
    })
}

/// A JSON object, kept in the order it arrived: speech reads places in that order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Ordered<T>(pub Vec<(String, T)>);

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Ordered<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V<T>(std::marker::PhantomData<T>);
        impl<'de, T: Deserialize<'de>> Visitor<'de> for V<T> {
            type Value = Ordered<T>;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut out = Vec::with_capacity(map.size_hint().unwrap_or(0));
                while let Some((k, v)) = map.next_entry::<String, T>()? {
                    out.push((k, v));
                }
                Ok(Ordered(out))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Ordered(Vec::new()))
            }
            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(Ordered(Vec::new()))
            }
        }
        d.deserialize_any(V(std::marker::PhantomData))
    }
}

/// `{ "level": [town codes] }`, as levels and codes.
pub type Area = Vec<(i32, Vec<i32>)>;

fn de_area<'de, D: Deserializer<'de>>(d: D) -> Result<Area, D::Error> {
    let raw: Ordered<Value> = Ordered::deserialize(d)?;
    Ok(raw
        .0
        .into_iter()
        .filter_map(|(level, codes)| {
            let level = level.parse::<f64>().ok()? as i32;
            let codes = codes
                .as_array()?
                .iter()
                .map(lenient)
                .filter(|n| !n.is_nan())
                .map(|n| n as i32)
                .collect();
            Some((level, codes))
        })
        .collect())
}

pub fn max_level(area: &Area) -> i32 {
    area.iter().map(|(level, _)| *level).max().unwrap_or(0)
}

/// `{ level: [codes] }` to `{ code: level }`. A code listed twice keeps the later.
pub fn area_by_code(area: &Area) -> HashMap<i32, i32> {
    let mut out = HashMap::new();
    for (level, codes) in area {
        for code in codes {
            out.insert(*code, *level);
        }
    }
    out
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct Eq {
    #[serde(deserialize_with = "de_f64")]
    pub lat: f64,
    #[serde(deserialize_with = "de_f64")]
    pub lon: f64,
    #[serde(deserialize_with = "de_f64")]
    pub depth: f64,
    #[serde(deserialize_with = "de_f64")]
    pub mag: f64,
    #[serde(deserialize_with = "de_i32")]
    pub max: i32,
    #[serde(deserialize_with = "de_string")]
    pub loc: String,
    #[serde(deserialize_with = "de_f64")]
    pub time: f64,
    #[serde(deserialize_with = "de_area")]
    pub area: Area,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct EewData {
    #[serde(deserialize_with = "de_string")]
    pub id: String,
    #[serde(deserialize_with = "de_string")]
    pub author: String,
    #[serde(deserialize_with = "de_i64")]
    pub serial: i64,
    /// 0 warn, 1 alert, 3 cancel.
    #[serde(deserialize_with = "de_i32")]
    pub status: i32,
    #[serde(rename = "final", deserialize_with = "de_truthy")]
    pub is_final: bool,
    pub eq: Eq,
    #[serde(deserialize_with = "de_f64")]
    pub time: f64,
    #[serde(rename = "EewEnd", deserialize_with = "de_truthy")]
    pub eew_end: bool,
    #[serde(skip)]
    pub status3_time: f64,
    #[serde(skip)]
    pub dist: Option<trem_core::travel_time::PsWaveDist>,
}

/// A frame's list. Not an array (a lone object) reads as nothing, as `Array.from` did.
pub fn parse_eew_list(value: &Value) -> Vec<EewData> {
    let Some(list) = value.as_array() else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|item| serde_json::from_value(item.clone()).ok())
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RtsStation {
    pub pga: f64,
    pub i: f64,
    pub alert: bool,
}

/// One earthquake of rts.v1's `eq`: lat, lon, depth km, origin unix seconds.
pub type RtsEq = [f64; 4];

#[derive(Clone, Debug, Default, PartialEq)]
pub struct RtsData {
    pub station: Vec<(StationId, RtsStation)>,
    pub boxes: Vec<(u32, i32)>,
    /// (town code, level), highest first.
    pub int: Vec<(i32, i32)>,
    pub time: f64,
    pub eq: Vec<RtsEq>,
}

impl RtsData {
    pub fn box_level(&self, id: u32) -> Option<i32> {
        self.boxes.iter().find(|(b, _)| *b == id).map(|(_, l)| *l)
    }
}

/// `eq` of rts.v1, keeping only entries of four finite numbers.
pub fn read_eq(value: &Value) -> Vec<RtsEq> {
    let Some(list) = value.as_array() else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|e| {
            let e = e.as_array()?;
            if e.len() < 4 {
                return None;
            }
            let mut out = [0.0; 4];
            for (slot, value) in out.iter_mut().zip(e) {
                *slot = value.as_f64().filter(|n| n.is_finite())?;
            }
            Some(out)
        })
        .collect()
}

/// A frame's `stations`, read in place: no [`Value`] per station.
#[derive(Default)]
pub struct RawStations(pub Vec<(StationId, RtsStation)>);

#[derive(Default, Deserialize)]
#[serde(default)]
struct RawStation {
    i: Option<Value>,
    pga: Option<Value>,
    alert: Option<Value>,
}

impl<'de> Deserialize<'de> for RawStations {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = RawStations;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a map of stations")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut out = Vec::with_capacity(map.size_hint().unwrap_or(1024));
                while let Some(key) = map.next_key::<std::borrow::Cow<'de, str>>()? {
                    let raw: RawStation = map.next_value()?;
                    let Some(id) = StationId::new(&key) else {
                        continue;
                    };
                    // Only a number: a station with no reading is left out.
                    let Some(i) = raw.i.as_ref().and_then(Value::as_f64) else {
                        continue;
                    };
                    let pga = raw.pga.as_ref().and_then(Value::as_f64).unwrap_or(0.0);
                    let alert = match raw.alert {
                        Some(Value::Number(n)) => n.as_f64() == Some(1.0),
                        Some(Value::String(s)) => s == "1",
                        Some(Value::Bool(b)) => b,
                        _ => false,
                    };
                    out.push((id, RtsStation { pga, i, alert }));
                }
                Ok(RawStations(out))
            }
        }
        d.deserialize_map(V)
    }
}

/// rts.v1, before the world is consulted: what a worker thread can do alone.
#[derive(Default, Deserialize)]
#[serde(default)]
pub struct RtsV1 {
    pub ts: Option<f64>,
    pub stations: Option<RawStations>,
    pub eq: Option<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Station {
    pub code: i32,
    pub lon: f64,
    pub lat: f64,
    pub work: Option<bool>,
}

pub type Stations = Arc<HashMap<StationId, Station>>;

/// The CSV at static.core/resource/station. Columns are found by header.
pub fn parse_station_csv(text: &str) -> HashMap<StationId, Station> {
    let mut lines = text.trim().lines();
    let Some(header) = lines.next() else {
        return HashMap::new();
    };
    let cols: Vec<&str> = header.split(',').map(str::trim).collect();
    let col = |name: &str| cols.iter().position(|c| *c == name);
    let (Some(id_at), Some(lat_at), Some(lon_at), Some(code_at)) =
        (col("id"), col("lat"), col("lon"), col("code"))
    else {
        return HashMap::new();
    };
    let work_at = col("work");
    let mut out = HashMap::new();
    for row in lines {
        let cell: Vec<&str> = row.split(',').map(str::trim).collect();
        let Some(id) = cell.get(id_at).and_then(|id| StationId::new(id)) else {
            continue;
        };
        let lat = cell.get(lat_at).and_then(|v| v.parse::<f64>().ok());
        let lon = cell.get(lon_at).and_then(|v| v.parse::<f64>().ok());
        let (Some(lat), Some(lon)) = (lat, lon) else {
            continue;
        };
        if !lat.is_finite() || !lon.is_finite() {
            continue;
        }
        out.insert(
            id,
            Station {
                code: cell.get(code_at).and_then(|v| v.parse().ok()).unwrap_or(0),
                lon,
                lat,
                work: work_at.map(|at| cell.get(at).is_some_and(|w| *w == "1")),
            },
        );
    }
    out
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct LegacyInfo {
    #[serde(deserialize_with = "de_i32")]
    code: i32,
    #[serde(deserialize_with = "de_f64")]
    lon: f64,
    #[serde(deserialize_with = "de_f64")]
    lat: f64,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct LegacyStation {
    info: Vec<LegacyInfo>,
    work: Option<bool>,
}

/// api/v1/trem/station. A station's place is its last `info` entry.
pub fn parse_legacy_stations(text: &str) -> Result<HashMap<StationId, Station>, String> {
    let raw: Ordered<LegacyStation> = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let mut out = HashMap::with_capacity(raw.0.len());
    for (id, station) in raw.0 {
        let (Some(id), Some(info)) = (StationId::new(&id), station.info.last()) else {
            continue;
        };
        out.insert(
            id,
            Station {
                code: info.code,
                lon: info.lon,
                lat: info.lat,
                work: station.work,
            },
        );
    }
    Ok(out)
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct ReportTown {
    #[serde(deserialize_with = "de_i32")]
    pub int: i32,
    #[serde(deserialize_with = "de_f64")]
    pub lon: f64,
    #[serde(deserialize_with = "de_f64")]
    pub lat: f64,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct ReportCity {
    #[serde(deserialize_with = "de_i32")]
    pub int: i32,
    pub town: Ordered<ReportTown>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct ReportListItem {
    #[serde(deserialize_with = "de_string")]
    pub id: String,
    #[serde(deserialize_with = "de_f64")]
    pub lat: f64,
    #[serde(deserialize_with = "de_f64")]
    pub lon: f64,
    #[serde(deserialize_with = "de_f64")]
    pub depth: f64,
    #[serde(deserialize_with = "de_string")]
    pub loc: String,
    #[serde(deserialize_with = "de_f64")]
    pub mag: f64,
    #[serde(deserialize_with = "de_f64")]
    pub time: f64,
    #[serde(deserialize_with = "de_f64")]
    pub trem: f64,
    #[serde(deserialize_with = "de_i32")]
    pub int: i32,
    pub list: Ordered<ReportCity>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct IntensityReport {
    /// Epoch ms of the shake.
    pub id: f64,
    pub serial: i64,
    pub status: String,
    pub max: i32,
    pub area: Area,
    pub ended: bool,
}

/// api/v3/trem/intensity (features/data/intensityV1.ts).
pub fn read_intensity_v1(value: &Value) -> Option<Vec<IntensityReport>> {
    let list = value.as_array()?;
    let mut out = Vec::with_capacity(list.len());
    for r in list {
        let (Some(id), Some(serial)) = (
            r.get("id").and_then(Value::as_f64),
            r.get("serial").and_then(Value::as_f64),
        ) else {
            continue;
        };
        let area = r
            .get("area")
            .and_then(|a| de_area(a.clone()).ok())
            .unwrap_or_default();
        out.push(IntensityReport {
            id: id * 1000.0,
            serial: serial as i64,
            status: r
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            max: max_level(&area),
            area,
            ended: false,
        });
    }
    Some(out)
}

/// Replay files hold the older shape: `{id, serial, max, area}` with `id` in ms.
pub fn read_intensity_file(value: &Value) -> Vec<IntensityReport> {
    let Some(list) = value.as_array() else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|r| {
            let id = r.get("id").and_then(Value::as_f64)?;
            let area = r
                .get("area")
                .and_then(|a| de_area(a.clone()).ok())
                .unwrap_or_default();
            Some(IntensityReport {
                id,
                serial: r.get("serial").and_then(Value::as_i64).unwrap_or(0),
                status: String::new(),
                max: r
                    .get("max")
                    .and_then(Value::as_i64)
                    .map_or_else(|| max_level(&area), |m| m as i32),
                area,
                ended: r
                    .get("IntensityEnd")
                    .is_some_and(|e| !e.is_null() && e != &Value::Bool(false)),
            })
        })
        .collect()
}

const LEVEL_CODES: [&str; 10] = ["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"];

fn between<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = text.find(open)? + open.len();
    let end = text[start..].find(close)? + start;
    Some(&text[start..end])
}

/// One shake report of trem.intensity.v1, which the server sends as TREM XML. EventID
/// is YYYYMMDDHHMMSS in +08:00, the same instant as the v3 JSON's epoch seconds.
pub fn read_intensity_xml(xml: &str) -> Option<IntensityReport> {
    use chrono::{FixedOffset, NaiveDate};
    let head = between(xml, "<Head>", "</Head>").unwrap_or("");
    // The shake's id, not one of the RelatedEewEvents that follow it.
    let without_related = match (
        head.find("<RelatedEewEvents>"),
        head.find("</RelatedEewEvents>"),
    ) {
        (Some(a), Some(b)) if a < b => {
            format!("{}{}", &head[..a], &head[b + "</RelatedEewEvents>".len()..])
        }
        _ => head.to_string(),
    };
    let stamp = between(&without_related, "<EventID>", "</EventID>")?;
    if stamp.len() != 14 || !stamp.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let serial: i64 = between(head, "<Serial>", "</Serial>")?.parse().ok()?;
    let part = |at: usize, len: usize| stamp[at..at + len].parse::<u32>().ok();
    let date = NaiveDate::from_ymd_opt(part(0, 4)? as i32, part(4, 2)?, part(6, 2)?)?;
    let time = date.and_hms_opt(part(8, 2)?, part(10, 2)?, part(12, 2)?)?;
    let offset = FixedOffset::east_opt(8 * 3600)?;
    let id = time.and_local_timezone(offset).single()?.timestamp_millis() as f64;

    let mut area: Area = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<Area level=\"") {
        let after = &rest[start + "<Area level=\"".len()..];
        let Some(quote) = after.find('"') else {
            break;
        };
        let code = &after[..quote];
        let Some(end) = after.find("</Area>") else {
            break;
        };
        let body = &after[quote..end];
        rest = &after[end + "</Area>".len()..];
        let Some(level) = LEVEL_CODES.iter().position(|c| *c == code) else {
            continue;
        };
        if level < 1 {
            continue;
        }
        let mut towns = Vec::new();
        let mut scan = body;
        while let Some(at) = scan.find("<Town code=\"") {
            scan = &scan[at + "<Town code=\"".len()..];
            let Some(q) = scan.find('"') else {
                break;
            };
            if let Ok(town) = scan[..q].parse() {
                towns.push(town);
            }
            scan = &scan[q..];
        }
        area.push((level as i32, towns));
    }
    let info = between(head, "<InfoType>", "</InfoType>").unwrap_or("");
    Some(IntensityReport {
        id,
        serial,
        status: match info {
            "發表" => "issued",
            "更新" => "updated",
            "最終" => "final",
            "取消" => "cancel",
            other => other,
        }
        .to_string(),
        max: max_level(&area),
        area,
        ended: false,
    })
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct LpgmItem {
    #[serde(deserialize_with = "de_string")]
    pub id: String,
    #[serde(deserialize_with = "de_i32")]
    pub lpgm: i32,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct LpgmData {
    #[serde(deserialize_with = "de_f64")]
    pub id: f64,
    #[serde(deserialize_with = "de_f64")]
    pub time: f64,
    #[serde(rename = "LpgmEnd", deserialize_with = "de_truthy")]
    pub ended: bool,
    pub list: Vec<LpgmItem>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_reads_without_a_value_per_station() {
        let v1: RtsV1 = serde_json::from_str(
            r#"{"source":"x","ts":1790487323000,
                "stations":{"117825C":{"i":-0.3,"pga":0.47,"alert":1},
                            "11AAAAA":{"i":1.2},
                            "BAD":{"pga":3},
                            "TOOLONGSTATIONID":{"i":1}},
                "eq":[[23.5,121.6,10,1790487300],[1,2],["a",1,2,3]]}"#,
        )
        .unwrap_or_default();
        let stations = v1.stations.unwrap_or_default().0;
        assert_eq!(stations.len(), 2);
        assert_eq!(stations[0].0.as_str(), "117825C");
        assert!(stations[0].1.alert);
        assert_eq!(stations[1].1.pga, 0.0);
        assert!(!stations[1].1.alert);
        assert_eq!(read_eq(&v1.eq.unwrap_or_default()).len(), 1);
    }

    #[test]
    fn stations_read_by_header_not_position() {
        let list = parse_station_csv(
            "loc_code,id,lat,lon,floor,code,net,time,work\n1,117825C,23.5,121.6,1,970,MS-Net,0,1\n2,,1,2,1,1,x,0,0\n",
        );
        assert_eq!(list.len(), 1);
        let station = list[&StationId::new("117825C").unwrap_or_default()];
        assert_eq!((station.code, station.lon), (970, 121.6));
        assert_eq!(station.work, Some(true));
    }

    #[test]
    fn xml_gives_the_same_id_as_the_json_feed() {
        let report = read_intensity_xml(
            r#"<Report><Head><EventID>20260726203641</EventID><InfoType>更新</InfoType><Serial>2</Serial>
               <RelatedEewEvents><EventID>99999999999999</EventID></RelatedEewEvents></Head>
               <Body><Area level="5-"><Town code="100"/><Town code="101"/></Area><Area level="2"><Town code="970"/></Area><Area level="0"><Town code="1"/></Area></Body></Report>"#,
        );
        let report = report.unwrap_or_default();
        // 2026-07-26 12:36:41 UTC.
        assert_eq!(report.id, 1_785_069_401_000.0);
        assert_eq!(report.serial, 2);
        assert_eq!(report.status, "updated");
        assert_eq!(report.max, 5);
        assert_eq!(report.area, vec![(5, vec![100, 101]), (2, vec![970])]);
    }

    #[test]
    fn the_json_feed_scales_its_id_and_derives_max() {
        let v: Value = serde_json::from_str(
            r#"[{"id":1790494393,"serial":2,"status":"final","area":{"2":[970],"1":[972,973]}},{"serial":1}]"#,
        )
        .unwrap_or_default();
        let list = read_intensity_v1(&v).unwrap_or_default();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, 1_790_494_393_000.0);
        assert_eq!(list[0].max, 2);
    }

    #[test]
    fn an_eew_reads_tolerantly() {
        let v: Value = serde_json::from_str(
            r#"[{"id":"1150001","author":"cwa","serial":"2","status":1,"final":0,"time":5,
                 "eq":{"lat":23.1,"lon":"121.2","depth":10,"mag":5.9,"max":5,"loc":"花蓮","time":7,"area":{"5":[970]}}},
                {"eq":null}]"#,
        )
        .unwrap_or_default();
        let list = parse_eew_list(&v);
        assert_eq!(list[0].serial, 2);
        assert_eq!(list[0].eq.lon, 121.2);
        assert_eq!(list[0].eq.area, vec![(5, vec![970])]);
        assert!(!list[0].is_final);
        assert_eq!(parse_eew_list(&Value::Null).len(), 0);
    }
}
