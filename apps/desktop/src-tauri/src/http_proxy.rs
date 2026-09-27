//! The single outbound HTTP path for the app.
//!
//! Every buffered request the frontend makes lands here (see
//! `packages/core/src/lib/http`). Nothing in the renderer is allowed to call
//! `fetch` directly, so this is the one place that owns:
//!
//! * **gzip** — reqwest is built with `.gzip(true)`, which adds
//!   `Accept-Encoding: gzip` to every request and transparently decodes the
//!   response. Bodies are then re-compressed at maximum level for storage.
//! * **ETag revalidation** — a stored validator is replayed as `If-None-Match`
//!   / `If-Modified-Since`; a 304 costs one set of headers instead of a body.
//! * **Freshness** — while a stored copy is younger than the server's
//!   `max-age`, or the caller's `max_age_ms` for content it knows does not
//!   change, it is served without asking the server at all.
//! * **LRU persistence** — see [`crate::http_cache`].
//! * **Stale-on-error** — if the network fails outright but we hold a cached
//!   body, the app gets the stale copy rather than nothing.
//! * **Regional routing** — a DNS-balanced ExpTech name is sent to its pool's
//!   healthy regional node instead (see [`crate::endpoints`]). A request that
//!   gets no answer there, or a 5xx, is retried once on the next healthy node.
//!
//! Long-lived responses (SSE) deliberately do *not* come through here; they
//! stay on `tauri-plugin-http`'s streaming `fetch`, since a cache has nothing
//! to offer an infinite stream. The frontend routes those through the same
//! abstraction layer via its `stream()` entry point, which asks
//! [`http_resolve`] for the node and tells [`http_report`] how it went.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tauri::{Manager, State};
use tauri_plugin_http::reqwest;

use crate::endpoints::{Endpoints, Target};
use crate::http_cache::{gunzip, now_ms, CacheEntry, HttpCache, StoredResponse};

/// Hosts the proxy is willing to talk to. This command bypasses the
/// `http:default` scope in `capabilities/default.json`, so the allowlist is
/// restated here — and kept to what the app actually requests through it: the
/// ExpTech APIs and map tiles, and the map glyph CDN. (A CWA report page is
/// opened in the browser and the contributors image is an `<img>`; neither
/// comes through here.)
const ALLOWED_HOSTS: &[&str] = &["*.exptech.dev", "*.exptech.com.tw", "cdn.jsdelivr.net"];

/// Response headers worth carrying back to the renderer / storing. Keeping the
/// set small stops per-connection noise (`set-cookie`, `date`, `server`, …)
/// from bloating every cache row.
const KEPT_HEADERS: &[&str] = &[
    "content-type",
    "content-length",
    "etag",
    "last-modified",
    "cache-control",
    "age",
    "content-encoding",
];

const DEFAULT_TIMEOUT_MS: u64 = 10_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRequest {
    url: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    /// Participate in the SQLite ETag/LRU store. Defaults to true; the 1 Hz
    /// realtime pollers pass false so their never-repeating payloads don't
    /// churn the budget.
    #[serde(default)]
    store: Option<bool>,
    /// Serve a stored copy without asking the server while it is younger than
    /// this — for content known not to change, whatever its headers say. The
    /// map tiles are the case: sent `no-store`, with a Last-Modified that moves
    /// forward every minute or so, they would otherwise download afresh on
    /// every use.
    #[serde(default)]
    max_age_ms: Option<u64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxyMeta {
    status: u16,
    ok: bool,
    url: String,
    headers: HashMap<String, String>,
    /// Body came from SQLite rather than the wire (304 replay, or stale-on-error).
    from_cache: bool,
    /// Served despite a failed/absent revalidation — the body may be out of date.
    stale: bool,
}

pub struct ProxyState {
    client: reqwest::Client,
    /// The cache is internally concurrent (reader pool + writer thread), so it
    /// needs no outer lock — see [`crate::http_cache`]. Reads still run on the
    /// blocking pool because a pooled SQLite query and the gzip round trip are
    /// synchronous work that must not sit on a tokio worker: doing so once
    /// starved the executor badly enough to delay map-ready by 30 s.
    cache: Arc<HttpCache>,
    endpoints: Arc<Endpoints>,
}

impl ProxyState {
    pub fn new(app: &tauri::AppHandle) -> Result<Self, String> {
        let dir = app
            .path()
            .app_cache_dir()
            .map_err(|e| format!("no cache dir: {e}"))?;
        let cache = HttpCache::open(&dir.join("http-cache.sqlite"))?;

        let client = reqwest::Client::builder()
            // Forces `Accept-Encoding: gzip` and transparent decoding.
            .gzip(true)
            .user_agent(concat!("TREM-Lite/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| e.to_string())?;

        let endpoints = Arc::new(Endpoints::new(client.clone()));
        endpoints.start();

        Ok(Self {
            client,
            cache: Arc::new(cache),
            endpoints,
        })
    }
}

fn host_allowed(host: &str) -> bool {
    ALLOWED_HOSTS.iter().any(|pattern| {
        match pattern.strip_prefix("*.") {
            // `*.example.com` covers sub.example.com and example.com itself.
            Some(suffix) => host == suffix || host.ends_with(&format!(".{suffix}")),
            None => host == *pattern,
        }
    })
}

/// `[u32 LE meta length][meta JSON][body bytes]`.
///
/// Tauri's IPC would turn a `Vec<u8>` field inside a JSON payload into an array
/// of numbers, which is ruinous for tile-sized bodies. Returning a raw
/// `ipc::Response` keeps the body as bytes, so the metadata rides in front of
/// it in the same buffer.
fn frame(meta: &ProxyMeta, body: &[u8]) -> tauri::ipc::Response {
    let meta_json = serde_json::to_vec(meta).unwrap_or_else(|_| b"{}".to_vec());
    let mut out = Vec::with_capacity(4 + meta_json.len() + body.len());
    out.extend_from_slice(&(meta_json.len() as u32).to_le_bytes());
    out.extend_from_slice(&meta_json);
    out.extend_from_slice(body);
    tauri::ipc::Response::new(out)
}

/// `url` sent to `target`'s host, or unchanged when there is no target.
fn at(url: &reqwest::Url, target: Option<Target>) -> reqwest::Url {
    let mut url = url.clone();
    if let Some(target) = target {
        // A host from the endpoint table always parses.
        let _ = url.set_host(Some(target.host));
    }
    url
}

/// `max-age` from a stored Cache-Control, in ms. Zero without one, or when the
/// server asks for every use to be checked (`no-cache`, `no-store`).
fn server_max_age_ms(headers: &HashMap<String, String>) -> u64 {
    let Some(cc) = headers.get("cache-control") else {
        return 0;
    };
    let mut max_age: u64 = 0;
    for directive in cc.split(',').map(|d| d.trim().to_ascii_lowercase()) {
        if directive == "no-cache" || directive == "no-store" {
            return 0;
        }
        if let Some(value) = directive.strip_prefix("max-age=") {
            max_age = value.trim_matches('"').parse().unwrap_or(0);
        }
    }
    max_age.saturating_mul(1000)
}

/// Whether `entry` may be served as it is: its age — upstream caches' `Age`
/// when it was stored, plus the time since — within the longer of the
/// caller's `max_age_ms` and the server's `max-age`. A row stored "in the
/// future" (the clock went back) is not trusted to be fresh.
fn fresh(entry: &CacheEntry, max_age_ms: Option<u64>, now: i64) -> bool {
    let lifetime = max_age_ms
        .unwrap_or(0)
        .max(server_max_age_ms(&entry.headers));
    let upstream = entry
        .headers
        .get("age")
        .and_then(|a| a.trim().parse::<u64>().ok())
        .unwrap_or(0);
    let resident = u64::try_from(now - entry.stored_at).unwrap_or(u64::MAX);
    upstream.saturating_mul(1000).saturating_add(resident) < lifetime
}

/// No answer, or the node answered that it cannot serve right now. A 4xx is a
/// working node saying no, and does not count.
fn node_failed(result: &Result<reqwest::Response, reqwest::Error>) -> bool {
    match result {
        Ok(res) => res.status().is_server_error(),
        Err(_) => true,
    }
}

/// Read a cache row on the blocking pool. Concurrent calls use separate
/// pooled connections, so tile bursts revalidate in parallel.
async fn cache_get(cache: &Arc<HttpCache>, key: String) -> Option<CacheEntry> {
    let cache = cache.clone();
    tauri::async_runtime::spawn_blocking(move || cache.get(&key))
        .await
        .ok()
        .flatten()
}

/// Bump an entry's LRU position and decompress it.
///
/// `touch` is a channel send that returns at once; only the gunzip needs the
/// blocking pool, and it runs in parallel with every other in-flight replay.
async fn cache_replay(cache: &Arc<HttpCache>, key: String, body_gz: Vec<u8>) -> Option<Vec<u8>> {
    cache.touch(&key);
    tauri::async_runtime::spawn_blocking(move || gunzip(&body_gz))
        .await
        .ok()
        .flatten()
}

/// Compress and store without blocking the response.
///
/// Detached on purpose: the renderer already has the bytes, so making it wait
/// for max-level deflate would put cache maintenance on the critical path of
/// every tile. Compression happens here, on the blocking pool, so it spreads
/// across cores; the writer thread then only does I/O.
fn cache_put_detached(cache: &Arc<HttpCache>, res: StoredResponse) {
    let cache = cache.clone();
    tauri::async_runtime::spawn_blocking(move || cache.put(res.compress()));
}

#[tauri::command]
pub async fn http_request(
    state: State<'_, ProxyState>,
    req: ProxyRequest,
) -> Result<tauri::ipc::Response, String> {
    let parsed = reqwest::Url::parse(&req.url).map_err(|e| format!("bad url: {e}"))?;
    if parsed.scheme() != "https" {
        return Err(format!("blocked scheme: {}", parsed.scheme()));
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if !host_allowed(&host) {
        return Err(format!("host not allowed: {host}"));
    }

    let method = req.method.as_deref().unwrap_or("GET").to_ascii_uppercase();
    let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    // Only idempotent, body-less methods are ever cacheable.
    let store = req.store.unwrap_or(true) && (method == "GET" || method == "HEAD");
    let key = format!("{method} {}", req.url);

    // The stored validator, read before touching the network.
    let cached = if store {
        cache_get(&state.cache, key.clone()).await
    } else {
        None
    };

    // Still fresh: no request at all. A row that fails to decode is treated
    // as absent.
    let cached = match cached {
        Some(entry) if fresh(&entry, req.max_age_ms, now_ms()) => {
            let (status, headers) = (entry.status, entry.headers);
            if let Some(body) = cache_replay(&state.cache, key.clone(), entry.body_gz).await {
                let meta = ProxyMeta {
                    status,
                    ok: (200..300).contains(&status),
                    url: req.url.clone(),
                    headers,
                    from_cache: true,
                    stale: false,
                };
                return Ok(frame(&meta, &body));
            }
            None
        }
        other => other,
    };

    let http_method =
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| format!("bad method: {e}"))?;
    // One attempt at `url`. A builder is spent by sending it, so the retry
    // below builds its own.
    let send = |url: reqwest::Url| {
        let mut builder = state
            .client
            .request(http_method.clone(), url)
            .timeout(timeout);
        for (name, value) in &req.headers {
            // Never let a caller hand-set Accept-Encoding: doing so switches
            // reqwest out of transparent decoding and we would store junk.
            if name.eq_ignore_ascii_case("accept-encoding") {
                continue;
            }
            builder = builder.header(name, value);
        }
        if let Some(entry) = &cached {
            if let Some(etag) = &entry.etag {
                builder = builder.header("If-None-Match", etag);
            }
            if let Some(lm) = &entry.last_modified {
                builder = builder.header("If-Modified-Since", lm);
            }
        }
        builder.send()
    };

    // The cache key stays the balanced URL, so both nodes of a pool share one
    // entry. Their validators differ, which costs a full answer — never a
    // wrong one — the first time the other node serves it.
    let target = state.endpoints.route(&host);
    let mut result = send(at(&parsed, target)).await;
    if let Some(first) = target {
        let failed = node_failed(&result);
        state.endpoints.report(first, !failed);
        if failed {
            if let Some(next) = state.endpoints.alternative(first) {
                result = send(at(&parsed, Some(next))).await;
                state.endpoints.report(next, !node_failed(&result));
            }
        }
    }

    let response = match result {
        Ok(res) => res,
        Err(err) => {
            // Network failure: a stale body beats no body at all.
            if let Some(entry) = cached {
                if let Some(body) = cache_replay(&state.cache, key.clone(), entry.body_gz).await {
                    let meta = ProxyMeta {
                        status: entry.status,
                        ok: (200..300).contains(&entry.status),
                        url: req.url.clone(),
                        headers: entry.headers,
                        from_cache: true,
                        stale: true,
                    };
                    return Ok(frame(&meta, &body));
                }
            }
            return Err(format!("network error: {err}"));
        }
    };

    let status = response.status().as_u16();
    let final_url = response.url().to_string();

    let mut headers: HashMap<String, String> = HashMap::new();
    for name in KEPT_HEADERS {
        if let Some(value) = response.headers().get(*name) {
            if let Ok(text) = value.to_str() {
                headers.insert((*name).to_string(), text.to_string());
            }
        }
    }

    // 304: the stored body is still current. Its freshness starts over; bump
    // its LRU position and replay it.
    if status == 304 {
        if let Some(entry) = cached {
            state.cache.validated(&key);
            if let Some(body) = cache_replay(&state.cache, key.clone(), entry.body_gz).await {
                let meta = ProxyMeta {
                    status: entry.status,
                    ok: (200..300).contains(&entry.status),
                    url: final_url,
                    headers: entry.headers,
                    from_cache: true,
                    stale: false,
                };
                return Ok(frame(&meta, &body));
            }
        }
        // Server said "unchanged" but our row is gone or corrupt. Nothing to
        // serve, and re-requesting here would risk a loop.
        return Err("304 without a usable cached body".into());
    }

    let etag = headers.get("etag").cloned();
    let last_modified = headers.get("last-modified").cloned();

    let body = response
        .bytes()
        .await
        .map_err(|e| format!("body error: {e}"))?
        .to_vec();

    // Content-Encoding/Length describe the wire form reqwest already undid;
    // leaving them on would make the renderer think the bytes are compressed.
    headers.remove("content-encoding");
    headers.remove("content-length");

    if store && status == 200 {
        cache_put_detached(
            &state.cache,
            StoredResponse {
                key,
                url: req.url.clone(),
                status,
                etag,
                last_modified,
                headers: headers.clone(),
                body: body.clone(),
            },
        );
    }

    let meta = ProxyMeta {
        status,
        ok: (200..300).contains(&status),
        url: final_url,
        headers,
        from_cache: false,
        stale: false,
    };
    Ok(frame(&meta, &body))
}

/// The URL a stream should open: a balanced name swapped for its pool's
/// active node, anything else unchanged. Streams stay on the plugin's `fetch`
/// (see the top of this file), so they ask here rather than go through
/// [`http_request`].
#[tauri::command]
pub fn http_resolve(state: State<'_, ProxyState>, url: String) -> Result<String, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("bad url: {e}"))?;
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    Ok(at(&parsed, state.endpoints.route(&host)).to_string())
}

/// How a stream opened from [`http_resolve`]'s URL went, so a node that keeps
/// refusing or dropping streams is failed over like one that fails requests.
#[tauri::command]
pub fn http_report(state: State<'_, ProxyState>, url: String, ok: bool) {
    let host = reqwest::Url::parse(&url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase));
    if let Some(target) = host.and_then(|h| state.endpoints.node(&h)) {
        state.endpoints.report(target, ok);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(headers: &[(&str, &str)], stored_at: i64) -> CacheEntry {
        CacheEntry {
            status: 200,
            etag: None,
            last_modified: None,
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            body_gz: Vec::new(),
            stored_at,
        }
    }

    #[test]
    fn a_stored_copy_is_fresh_for_the_longer_of_the_two_lifetimes() {
        let now = 1_000_000_000;
        let min = 60_000;
        // The caller's hint alone: tiles sent no-store.
        let tile = entry(&[("cache-control", "no-store")], now - 5 * min);
        assert!(fresh(&tile, Some(10 * min as u64), now));
        assert!(!fresh(&tile, Some(4 * min as u64), now));
        assert!(!fresh(&tile, None, now));
        // The server's max-age alone, less what upstream caches had used.
        let glyph = entry(
            &[("cache-control", "public, max-age=600"), ("age", "240")],
            now - 5 * min,
        );
        assert!(fresh(&glyph, None, now)); // 240 s + 300 s < 600 s
        let older = entry(
            &[("cache-control", "public, max-age=600"), ("age", "240")],
            now - 7 * min,
        );
        assert!(!fresh(&older, None, now)); // 240 s + 420 s ≥ 600 s
    }

    #[test]
    fn nothing_without_a_lifetime_is_fresh() {
        let now = 1_000_000_000;
        for cc in ["no-cache, max-age=600", "max-age=600, no-store", ""] {
            assert!(
                !fresh(&entry(&[("cache-control", cc)], now - 1), None, now),
                "{cc}"
            );
        }
        assert!(!fresh(&entry(&[], now), None, now));
        // A clock that went backwards does not make anything fresher.
        assert!(!fresh(&entry(&[], now + 5_000), Some(1_000), now));
    }

    #[test]
    fn balanced_names_go_to_the_active_node_and_nothing_else_moves() {
        let endpoints = Endpoints::new(reqwest::Client::new());
        let url =
            reqwest::Url::parse("https://api.core.exptech.dev/api/v2/eq/report?limit=150").unwrap();
        assert_eq!(
            at(&url, endpoints.route("api.core.exptech.dev")).as_str(),
            "https://api.core-tnn1.exptech.dev/api/v2/eq/report?limit=150"
        );
        let other = reqwest::Url::parse("https://api-1.exptech.dev/api/v1/trem/station").unwrap();
        assert_eq!(at(&other, endpoints.route("api-1.exptech.dev")), other);
    }
}
