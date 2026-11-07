//! The two station lists (features/data/resource.ts): static.core's hex ids, which
//! rts.v1 reports, and the older network's decimal ids, which lpgm reports still name.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::app::{App, Msg};
use crate::domain::constants::timeout;
use crate::domain::types::{parse_legacy_stations, parse_station_csv, Station, StationId};
use crate::domain::utils::distance;
use crate::domain::utils::text_hash;
use crate::net::ProxyRequest;
use crate::timers::Task;

const STATIONS_URL: &str = "https://static.core.exptech.dev/resource/station";
/// Only api-1 serves the older list; the others answer 404.
const LEGACY_STATIONS_URL: &str = "https://api-1.exptech.dev/api/v1/trem/station";
/// How often each list is fetched; at start too.
const REFRESH_MS: f64 = 300_000.0;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StationKind {
    Current,
    Legacy,
}

impl StationKind {
    fn name(self) -> &'static str {
        match self {
            Self::Current => "測站清單",
            Self::Legacy => "舊版測站清單",
        }
    }

    fn url(self) -> &'static str {
        match self {
            Self::Current => STATIONS_URL,
            Self::Legacy => LEGACY_STATIONS_URL,
        }
    }

    /// Kept as the bytes that arrived: parsed again at the next start.
    fn cache_name(self) -> &'static str {
        match self {
            Self::Current => "cache.stations.csv",
            Self::Legacy => "cache.station.json",
        }
    }

    fn parse(self, text: &str) -> Result<HashMap<StationId, Station>, String> {
        match self {
            Self::Current => Ok(parse_station_csv(text)),
            Self::Legacy => parse_legacy_stations(text),
        }
    }
}

#[derive(Default)]
pub struct ResourceState {
    last_current: Arc<Mutex<Option<u64>>>,
    last_legacy: Arc<Mutex<Option<u64>>>,
}

impl App {
    pub fn resource_init(&mut self) {
        for kind in [StationKind::Current, StationKind::Legacy] {
            let cached = self
                .host
                .data_file(kind.cache_name())
                .and_then(|path| std::fs::read_to_string(path).ok())
                .and_then(|text| kind.parse(&text).ok())
                .filter(|list| !list.is_empty())
                .map(Arc::new);
            match kind {
                StationKind::Current => self.var.station = cached,
                StationKind::Legacy => self.var.legacy_station = cached,
            }
        }
        self.resource_fetch();
        self.timers.interval(REFRESH_MS, Task::ResourceFetch);
    }

    /// Keep each list current. The HTTP layer revalidates with its ETag, so an unchanged
    /// list is a 304 whose bytes match the last ones, and nothing more happens. A failed,
    /// empty or unreadable answer never replaces the list in hand.
    pub fn resource_fetch(&self) {
        for kind in [StationKind::Current, StationKind::Legacy] {
            let last = Arc::clone(match kind {
                StationKind::Current => &self.resource.last_current,
                StationKind::Legacy => &self.resource.last_legacy,
            });
            let cache = self.host.data_file(kind.cache_name());
            let req = ProxyRequest::get(kind.url(), timeout::RESOURCE);
            self.host.fetch(req, move |answer| {
                let name = kind.name();
                let reply = match answer {
                    Ok(reply) if reply.ok() => reply,
                    Ok(reply) => {
                        log::warn!(target: "station", "{name} 取得失敗（HTTP {}），沿用現有的", reply.status);
                        return None;
                    }
                    Err(err) => {
                        log::warn!(target: "station", "{name} 取得失敗，沿用現有的：{err}");
                        return None;
                    }
                };
                let text = String::from_utf8_lossy(&reply.body).into_owned();
                let hash = text_hash(&text);
                if last.lock().is_ok_and(|known| *known == Some(hash)) {
                    return None;
                }
                let list = match kind.parse(&text) {
                    Ok(list) => list,
                    Err(err) => {
                        log::warn!(target: "station", "{name} 解析失敗，沿用現有的：{err}");
                        return None;
                    }
                };
                if list.is_empty() {
                    log::warn!(target: "station", "{name} 上游回空表，沿用現有的");
                    return None;
                }
                if let Ok(mut known) = last.lock() {
                    *known = Some(hash);
                }
                if let Some(path) = cache {
                    // A full disk only costs the cache.
                    let _ = std::fs::write(path, text);
                }
                log::info!(target: "station", "{name} 更新：{} 站", list.len());
                Some(Msg::StationList { kind, list })
            });
        }
    }

    pub fn resource_list(&mut self, kind: StationKind, list: HashMap<StationId, Station>) {
        match kind {
            StationKind::Current => self.var.station = Some(Arc::new(list)),
            StationKind::Legacy => self.var.legacy_station = Some(Arc::new(list)),
        }
        self.migrate_realtime_station();
    }

    /// The chosen station, once written as a decimal id of the older network, becomes the
    /// nearest of the new one. Needs both lists: the old id's place is in the legacy list.
    fn migrate_realtime_station(&mut self) {
        let Some(stations) = self.var.station.clone() else {
            return;
        };
        let chosen = StationId::new(&self.config.station_id);
        if chosen.is_some_and(|id| stations.contains_key(&id)) {
            return;
        }
        let old = chosen.and_then(|id| {
            self.var
                .legacy_station
                .as_ref()
                .and_then(|list| list.get(&id))
                .copied()
        });
        // Wait for the legacy list, or an id neither list knows.
        let Some(old) = old else {
            return;
        };
        let mut nearest = None;
        let mut best = f64::INFINITY;
        for (id, at) in stations.iter() {
            let km = distance(old.lat, old.lon, at.lat, at.lon);
            if km < best {
                best = km;
                nearest = Some(*id);
            }
        }
        let Some(nearest) = nearest else {
            return;
        };
        log::info!(
            target: "station",
            "我的測站 {} 不在新的測站清單裡，改用最近的 {nearest}（相距 {best:.1} km）",
            self.config.station_id
        );
        let mut next = self.config.clone();
        next.station_id = nearest.to_string();
        self.write_config(next);
    }
}
