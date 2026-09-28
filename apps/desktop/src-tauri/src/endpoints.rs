//! Which regional node answers for each ExpTech service.
//!
//! Every service is published under a DNS-balanced name
//! (`api.core.exptech.dev`) and once per region (`api.core-tnn1.exptech.dev`,
//! `api.core-tyo1.exptech.dev`). The balanced names are never contacted: DNS
//! decides afresh on every lookup, so two requests a second apart can land in
//! regions whose data disagree — the "phantom drift" that once showed users two
//! different sets of earthquake reports. The frontend keeps writing the
//! balanced name, and [`Endpoints::route`] swaps in the pool's active node.
//!
//! The active node moves only when it has to: when it fails a probe, when it
//! fails [`FAILOVER_AFTER`] requests in a row, or when another node has become
//! at least twice as fast. Staying put is the point — every move is a chance of
//! drift.
//!
//! The web build has no Rust side and does the same in
//! `packages/core/src/lib/http/regions.ts`. The two tables must agree.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri_plugin_http::reqwest;

const PROBE_EVERY: Duration = Duration::from_secs(30);
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
/// Requests failed in a row before a node is taken out, without waiting for
/// the next probe.
const FAILOVER_AFTER: u32 = 3;
/// Weight of a new probe in the smoothed latency: one slow answer should not
/// move the active node on its own.
const SMOOTHING: f64 = 0.3;

struct Service {
    /// The DNS-balanced name the frontend writes.
    balanced: &'static str,
    /// One name per region, the nearest first: it answers until the first probe
    /// round is in.
    nodes: &'static [&'static str],
    /// A small path every node serves. HEAD where the body is not small.
    probe: &'static str,
    head: bool,
}

const SERVICES: &[Service] = &[
    Service {
        balanced: "api.lb.exptech.dev",
        nodes: &["api.lb-tpe1.exptech.dev", "api.lb-khh1.exptech.dev"],
        probe: "/api/v2/eq/eew",
        head: false,
    },
    Service {
        balanced: "static.lb.exptech.dev",
        nodes: &["static.lb-tpe1.exptech.dev", "static.lb-khh1.exptech.dev"],
        probe: "/api/v1/map/tiles/0/0/0.pbf",
        head: true,
    },
    Service {
        balanced: "api.core.exptech.dev",
        nodes: &["api.core-tnn1.exptech.dev", "api.core-tyo1.exptech.dev"],
        probe: "/api/v2/eq/eew",
        head: false,
    },
    Service {
        balanced: "static.core.exptech.dev",
        nodes: &[
            "static.core-tnn1.exptech.dev",
            "static.core-tyo1.exptech.dev",
        ],
        probe: "/resource/station",
        head: true,
    },
];

#[derive(Debug)]
struct Node {
    host: &'static str,
    healthy: bool,
    /// Smoothed probe round trip in ms; `None` until a probe has answered.
    latency: Option<f64>,
    /// Requests failed in a row since the last one that did not.
    failures: u32,
}

#[derive(Debug)]
struct Pool {
    nodes: Vec<Node>,
    active: usize,
}

impl Pool {
    fn new(service: &Service) -> Self {
        Self {
            nodes: service
                .nodes
                .iter()
                .map(|&host| Node {
                    host,
                    healthy: true,
                    latency: None,
                    failures: 0,
                })
                .collect(),
            active: 0,
        }
    }

    /// A probe's outcome: the round trip in ms, or `None` if it failed.
    fn probed(&mut self, node: usize, rtt: Option<f64>) {
        let n = &mut self.nodes[node];
        match rtt {
            Some(ms) => {
                n.healthy = true;
                n.failures = 0;
                n.latency = Some(match n.latency {
                    Some(old) => old + SMOOTHING * (ms - old),
                    None => ms,
                });
            }
            None => {
                n.healthy = false;
                n.latency = None;
            }
        }
    }

    /// A real request's outcome. Only a probe brings a node back, so success
    /// clears the count without touching `healthy`.
    fn reported(&mut self, node: usize, ok: bool) {
        let n = &mut self.nodes[node];
        if ok {
            n.failures = 0;
            return;
        }
        n.failures += 1;
        if n.failures >= FAILOVER_AFTER {
            n.healthy = false;
            n.latency = None;
        }
    }

    /// The fastest healthy node other than `except`. An unmeasured node ranks
    /// behind every measured one, and ties go to the one listed first.
    fn fastest(&self, except: Option<usize>) -> Option<usize> {
        let rank = |i: usize| self.nodes[i].latency.unwrap_or(f64::INFINITY);
        (0..self.nodes.len())
            .filter(|&i| Some(i) != except && self.nodes[i].healthy)
            .min_by(|&a, &b| rank(a).total_cmp(&rank(b)))
    }

    /// Moves `active` if it has to, and says from where to where.
    fn reselect(&mut self) -> Option<(usize, usize)> {
        let current = &self.nodes[self.active];
        let other = self.fastest(Some(self.active))?;
        let move_there = !current.healthy
            || match (current.latency, self.nodes[other].latency) {
                (Some(here), Some(there)) => there * 2.0 <= here,
                // The active node has never answered a probe; one that has wins.
                (None, Some(_)) => true,
                _ => false,
            };
        if !move_there {
            return None;
        }
        let from = self.active;
        self.active = other;
        Some((from, other))
    }
}

/// One node of one pool, as handed out by [`Endpoints::route`].
#[derive(Debug, Clone, Copy)]
pub struct Target {
    pool: usize,
    node: usize,
    pub host: &'static str,
}

pub struct Endpoints {
    pools: Mutex<Vec<Pool>>,
    client: reqwest::Client,
}

impl Endpoints {
    pub fn new(client: reqwest::Client) -> Self {
        Self {
            pools: Mutex::new(SERVICES.iter().map(Pool::new).collect()),
            client,
        }
    }

    fn pools(&self) -> std::sync::MutexGuard<'_, Vec<Pool>> {
        // Every critical section is a few field writes; a panic inside one
        // cannot leave a pool half-updated in a way worth refusing to read.
        self.pools.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The active node for a balanced name; `None` for any other host.
    pub fn route(&self, host: &str) -> Option<Target> {
        let pool = SERVICES.iter().position(|s| s.balanced == host)?;
        let node = self.pools()[pool].active;
        Some(Target {
            pool,
            node,
            host: SERVICES[pool].nodes[node],
        })
    }

    /// Where to try again after `failed` did not answer: the fastest other
    /// healthy node. None when there is no such node — retrying one already
    /// known to be down would only double the wait.
    pub fn alternative(&self, failed: Target) -> Option<Target> {
        let node = self.pools()[failed.pool].fastest(Some(failed.node))?;
        Some(Target {
            pool: failed.pool,
            node,
            host: SERVICES[failed.pool].nodes[node],
        })
    }

    /// The node a regional host belongs to, for outcomes reported by host.
    pub fn node(&self, host: &str) -> Option<Target> {
        SERVICES.iter().enumerate().find_map(|(pool, s)| {
            let node = s.nodes.iter().position(|&n| n == host)?;
            Some(Target {
                pool,
                node,
                host: s.nodes[node],
            })
        })
    }

    pub fn report(&self, target: Target, ok: bool) {
        let mut pools = self.pools();
        let pool = &mut pools[target.pool];
        let was_healthy = pool.nodes[target.node].healthy;
        pool.reported(target.node, ok);
        if was_healthy && !pool.nodes[target.node].healthy {
            log::warn!(
                "{} 連續 {FAILOVER_AFTER} 個請求失敗，標為不健康",
                target.host
            );
        }
        log_move(target.pool, pool.reselect());
    }

    async fn probe_all(&self) {
        let mut probes = Vec::new();
        for (pool, service) in SERVICES.iter().enumerate() {
            for (node, &host) in service.nodes.iter().enumerate() {
                let client = self.client.clone();
                probes.push(tauri::async_runtime::spawn(async move {
                    (pool, node, probe(&client, host, service).await)
                }));
            }
        }
        let mut results = Vec::with_capacity(probes.len());
        for probe in probes {
            if let Ok(result) = probe.await {
                results.push(result);
            }
        }

        let mut pools = self.pools();
        for (pool, node, rtt) in results {
            let n = &pools[pool].nodes[node];
            match (n.healthy, rtt) {
                (true, None) => log::warn!("{} 探測失敗，標為不健康", n.host),
                (false, Some(ms)) => log::info!("{} 恢復（探測 {ms:.0}ms）", n.host),
                _ => {}
            }
            pools[pool].probed(node, rtt);
        }
        for (pool, p) in pools.iter_mut().enumerate() {
            log_move(pool, p.reselect());
        }
    }

    /// Probes every node now, then every [`PROBE_EVERY`].
    pub fn start(self: &Arc<Self>) {
        let endpoints = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                endpoints.probe_all().await;
                tokio::time::sleep(PROBE_EVERY).await;
            }
        });
    }
}

fn log_move(pool: usize, moved: Option<(usize, usize)>) {
    if let Some((from, to)) = moved {
        let s = &SERVICES[pool];
        log::info!(
            "換節點：{} 從 {} 改走 {}",
            s.balanced,
            s.nodes[from],
            s.nodes[to]
        );
    }
}

/// The round trip in ms, or `None` for anything but a 2xx in time. The body
/// is read to the end, so the time covers the whole answer.
async fn probe(client: &reqwest::Client, host: &str, service: &Service) -> Option<f64> {
    let method = if service.head {
        reqwest::Method::HEAD
    } else {
        reqwest::Method::GET
    };
    let start = Instant::now();
    let res = client
        .request(method, format!("https://{host}{}", service.probe))
        .timeout(PROBE_TIMEOUT)
        .header("Cache-Control", "no-cache")
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    res.bytes().await.ok()?;
    Some(start.elapsed().as_secs_f64() * 1000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool() -> Pool {
        Pool::new(&SERVICES[2])
    }

    #[test]
    fn listed_first_answers_until_probed() {
        let mut p = pool();
        assert_eq!(p.active, 0);
        assert_eq!(p.reselect(), None);
    }

    #[test]
    fn stays_unless_twice_as_fast() {
        let mut p = pool();
        p.probed(0, Some(100.0));
        p.probed(1, Some(60.0));
        assert_eq!(
            p.reselect(),
            None,
            "60 ms against 100 ms is not worth a move"
        );
        p.probed(1, Some(10.0)); // smoothed: 60 + 0.3 × (10 − 60) = 45, under half of 100
        assert_eq!(p.reselect(), Some((0, 1)));
    }

    #[test]
    fn a_failed_probe_moves_at_once() {
        let mut p = pool();
        p.probed(0, Some(50.0));
        p.probed(1, Some(90.0));
        p.probed(0, None);
        assert_eq!(p.reselect(), Some((0, 1)));
    }

    #[test]
    fn requests_move_it_after_three_failures() {
        let mut p = pool();
        p.probed(0, Some(50.0));
        p.probed(1, Some(90.0));
        p.reported(0, false);
        p.reported(0, false);
        assert_eq!(p.reselect(), None);
        p.reported(0, true); // a success in between resets the count
        p.reported(0, false);
        p.reported(0, false);
        assert_eq!(p.reselect(), None);
        p.reported(0, false);
        assert_eq!(p.reselect(), Some((0, 1)));
    }

    #[test]
    fn does_not_move_back_when_the_first_recovers() {
        let mut p = pool();
        p.probed(0, Some(50.0));
        p.probed(1, Some(90.0));
        p.probed(0, None);
        p.reselect();
        p.probed(0, Some(50.0));
        assert_eq!(p.reselect(), None, "back, but not twice as fast");
        assert_eq!(p.active, 1);
    }

    #[test]
    fn nothing_healthy_keeps_the_active_node() {
        let mut p = pool();
        p.probed(0, None);
        p.probed(1, None);
        assert_eq!(p.reselect(), None);
        assert_eq!(p.fastest(None), None);
    }

    #[test]
    fn routes_balanced_names_only() {
        let client = reqwest::Client::new();
        let e = Endpoints::new(client);
        assert_eq!(
            e.route("api.core.exptech.dev").unwrap().host,
            "api.core-tnn1.exptech.dev"
        );
        assert!(e.route("api.core-tnn1.exptech.dev").is_none());
        assert!(e.route("api-1.exptech.dev").is_none());
        let node = e.node("static.lb-khh1.exptech.dev").unwrap();
        assert_eq!((node.pool, node.node), (1, 1));
    }
}
