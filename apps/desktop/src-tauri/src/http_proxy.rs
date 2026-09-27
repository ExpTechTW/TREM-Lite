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
//!   healthy regional node instead (see [`crate::endpoints`]).
//! * **Retries** — no answer, a 5xx or a 429 is tried again, up to
//!   [`MAX_ATTEMPTS`] times within the caller's timeout: at once on another
//!   healthy node when there is one, else after an exponential backoff.
//! * **Rate limits** — a 429 or 503 with `Retry-After` cools its host down for
//!   that long: meanwhile a stored copy is served as it is, and a request
//!   without one waits the cooldown out if its timeout allows. At most
//!   [`HOST_CONCURRENCY`] requests go to one host at a time, which smooths a
//!   burst of map tiles into a steady stream.
//! * **Single flight** — identical cacheable requests in flight at once share
//!   one exchange.
//!
//! The frontend therefore neither retries nor backs off: it asks once and gets
//! an answer, a stored one, or an error that means it.
//!
//! Long-lived responses (SSE) deliberately do *not* come through here; they
//! stay on `tauri-plugin-http`'s streaming `fetch`, since a cache has nothing
//! to offer an infinite stream. The frontend routes those through the same
//! abstraction layer via its `stream()` entry point, which asks
//! [`http_resolve`] for the node and tells [`http_report`] how it went.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{Manager, State};
use tauri_plugin_http::reqwest;
use tokio::sync::{OnceCell, Semaphore};

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

/// Tries per request, the first included.
const MAX_ATTEMPTS: u32 = 3;
/// The first backoff; each retry on the same node waits twice the last.
const BACKOFF_BASE: Duration = Duration::from_millis(300);
/// A `Retry-After` longer than this is capped: the app polls on its own.
const MAX_COOLDOWN: Duration = Duration::from_secs(60);
/// Requests in flight to one host at a time.
const HOST_CONCURRENCY: usize = 8;

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
    /// Hosts that asked to be left alone (429 / 503 + Retry-After), until when.
    cooldown: Mutex<HashMap<String, Instant>>,
    /// One gate per upstream host, HOST_CONCURRENCY wide.
    gates: Mutex<HashMap<String, Arc<Semaphore>>>,
    /// Cacheable requests in flight, by cache key: callers of the same one share it.
    inflight: Mutex<HashMap<String, Flight>>,
}

impl ProxyState {
    fn gate(&self, host: &str) -> Arc<Semaphore> {
        lock(&self.gates)
            .entry(host.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(HOST_CONCURRENCY)))
            .clone()
    }

    fn cooling(&self, host: &str) -> Option<Duration> {
        let until = *lock(&self.cooldown).get(host)?;
        until.checked_duration_since(Instant::now())
    }

    fn cool_down(&self, host: &str, wait: Duration) {
        lock(&self.cooldown).insert(host.to_string(), Instant::now() + wait.min(MAX_COOLDOWN));
    }

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
            cooldown: Mutex::new(HashMap::new()),
            gates: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
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

/// Every critical section is a map lookup or insert; a panic in one cannot
/// leave a map half-written in a way worth refusing to read.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// One cacheable request in flight, and what it came to.
type Flight = Arc<OnceCell<Result<Fetched, String>>>;

/// A finished exchange, as every caller of a single flight receives it.
#[derive(Clone)]
struct Fetched {
    status: u16,
    url: String,
    headers: HashMap<String, String>,
    body: Arc<Vec<u8>>,
    from_cache: bool,
    stale: bool,
}

impl Fetched {
    fn response(&self) -> tauri::ipc::Response {
        let meta = ProxyMeta {
            status: self.status,
            ok: (200..300).contains(&self.status),
            url: self.url.clone(),
            headers: self.headers.clone(),
            from_cache: self.from_cache,
            stale: self.stale,
        };
        frame(&meta, &self.body)
    }

    fn from_entry(entry: CacheEntry, url: String, body: Vec<u8>, stale: bool) -> Self {
        Self {
            status: entry.status,
            url,
            headers: entry.headers,
            body: Arc::new(body),
            from_cache: true,
            stale,
        }
    }
}

/// `Retry-After` in seconds (the HTTP-date form is not sent by ExpTech).
fn retry_after(res: &reqwest::Response) -> Option<Duration> {
    let secs = res
        .headers()
        .get("retry-after")?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()?;
    Some(Duration::from_secs(secs))
}

/// A tenth of `d` either way, so clients that failed together do not retry together.
fn jitter(d: Duration) -> Duration {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |t| t.subsec_nanos());
    let spread = d.as_millis() as u64 / 5;
    let offset = if spread == 0 {
        0
    } else {
        u64::from(nanos) % spread
    };
    (d + Duration::from_millis(offset)).saturating_sub(Duration::from_millis(spread / 2))
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
    request(&state, req, parsed, host)
        .await
        .map(|f| f.response())
}

/// A checked request: the cache, the in-flight table, then [`fetch`].
async fn request(
    state: &ProxyState,
    req: ProxyRequest,
    parsed: reqwest::Url,
    host: String,
) -> Result<Fetched, String> {
    let method = req.method.as_deref().unwrap_or("GET").to_ascii_uppercase();
    // Only idempotent, body-less methods are ever cacheable.
    let store = req.store.unwrap_or(true) && (method == "GET" || method == "HEAD");
    let key = format!("{method} {}", req.url);

    if !store {
        return fetch(state, &req, parsed, &host, &method, &key, false).await;
    }
    // A cacheable request joins one already in flight, or becomes it.
    let cell = lock(&state.inflight)
        .entry(key.clone())
        .or_insert_with(|| Arc::new(OnceCell::new()))
        .clone();
    let result = cell
        .get_or_init(|| fetch(state, &req, parsed, &host, &method, &key, true))
        .await
        .clone();
    {
        let mut inflight = lock(&state.inflight);
        if inflight.get(&key).is_some_and(|c| Arc::ptr_eq(c, &cell)) {
            inflight.remove(&key);
        }
    }
    result
}

/// One request, from the cache or the network, retried as the top of this
/// file says.
async fn fetch(
    state: &ProxyState,
    req: &ProxyRequest,
    parsed: reqwest::Url,
    host: &str,
    method: &str,
    key: &str,
    store: bool,
) -> Result<Fetched, String> {
    let deadline =
        Instant::now() + Duration::from_millis(req.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));

    // The stored validator, read before touching the network.
    let cached = if store {
        cache_get(&state.cache, key.to_string()).await
    } else {
        None
    };

    // Still fresh: no request at all. A row that fails to decode is treated
    // as absent.
    let cached = match cached {
        Some(entry) if fresh(&entry, req.max_age_ms, now_ms()) => {
            let body_gz = entry.body_gz.clone();
            match cache_replay(&state.cache, key.to_string(), body_gz).await {
                Some(body) => return Ok(Fetched::from_entry(entry, req.url.clone(), body, false)),
                None => None,
            }
        }
        other => other,
    };

    // A host cooling down: its stored copy, or a wait the timeout allows.
    if let Some(wait) = state.cooling(host) {
        if let Some(entry) = cached.clone() {
            let body_gz = entry.body_gz.clone();
            if let Some(body) = cache_replay(&state.cache, key.to_string(), body_gz).await {
                return Ok(Fetched::from_entry(entry, req.url.clone(), body, true));
            }
        }
        if Instant::now() + wait >= deadline {
            return Err(format!(
                "rate limited by {host} for {} s",
                wait.as_secs().max(1)
            ));
        }
        tokio::time::sleep(wait).await;
    }

    let http_method =
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| format!("bad method: {e}"))?;
    let send = |url: reqwest::Url, left: Duration| {
        let mut builder = state.client.request(http_method.clone(), url).timeout(left);
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
    let mut target = state.endpoints.route(host);
    let mut result: Result<reqwest::Response, String> = Err("no attempt".into());
    for attempt in 1..=MAX_ATTEMPTS {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        let url = at(&parsed, target);
        let upstream = url.host_str().unwrap_or(host).to_string();
        let gate = state.gate(&upstream);
        let Ok(_permit) = tokio::time::timeout(left, gate.acquire_owned()).await else {
            result = Err(format!("timed out waiting for {upstream}"));
            break;
        };
        let left = deadline.saturating_duration_since(Instant::now());
        let sent = send(url, left).await;
        let status = sent.as_ref().map(|r| r.status().as_u16()).ok();
        let failed = status.is_none_or(|s| s >= 500 || s == 429);
        if let Some(t) = target {
            // A 429 is a working node asking to slow down, not a dead one.
            state.endpoints.report(t, status == Some(429) || !failed);
        }
        let cooldown = sent
            .as_ref()
            .ok()
            .filter(|_| matches!(status, Some(429 | 503)))
            .and_then(retry_after);
        if let Some(wait) = cooldown {
            state.cool_down(&upstream, wait);
        }
        result = sent.map_err(|e| {
            if e.is_timeout() {
                format!("timed out: {e}")
            } else {
                format!("network error: {e}")
            }
        });
        if !failed || attempt == MAX_ATTEMPTS {
            break;
        }
        // Next: another healthy node at once, else this one after a backoff.
        match target.and_then(|t| state.endpoints.alternative(t)) {
            Some(next) => target = Some(next),
            None => {
                let backoff =
                    cooldown.unwrap_or_else(|| jitter(BACKOFF_BASE * 2u32.pow(attempt - 1)));
                if Instant::now() + backoff >= deadline {
                    break;
                }
                tokio::time::sleep(backoff).await;
            }
        }
    }

    // No usable answer — none at all, or a 5xx / 429 the retries did not get
    // past: a stale body beats no body. The failed answer is passed on only
    // when there is nothing stored.
    let usable = result.as_ref().is_ok_and(|r| {
        let s = r.status().as_u16();
        s < 500 && s != 429
    });
    if !usable {
        if let Some(entry) = cached.clone() {
            let body_gz = entry.body_gz.clone();
            if let Some(body) = cache_replay(&state.cache, key.to_string(), body_gz).await {
                return Ok(Fetched::from_entry(entry, req.url.clone(), body, true));
            }
        }
    }
    let response = result?;

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
            state.cache.validated(key);
            let body_gz = entry.body_gz.clone();
            if let Some(body) = cache_replay(&state.cache, key.to_string(), body_gz).await {
                return Ok(Fetched::from_entry(entry, final_url, body, false));
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
                key: key.to_string(),
                url: req.url.clone(),
                status,
                etag,
                last_modified,
                headers: headers.clone(),
                body: body.clone(),
            },
        );
    }

    Ok(Fetched {
        status,
        url: final_url,
        headers,
        body: Arc::new(body),
        from_cache: false,
        stale: false,
    })
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
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A plain-HTTP server answering from `reply` (by request count), and a
    /// proxy whose client reaches it at http://test.exptech.dev. Requests go
    /// through `request`, past the https/allow-list check.
    fn server(
        name: &str,
        reply: impl Fn(usize, &str) -> String + Send + Sync + 'static,
    ) -> (ProxyState, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let n = counter.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0u8; 4096];
                let len = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..len]).to_string();
                let _ = stream.write_all(reply(n, &request).as_bytes());
            }
        });
        let db =
            std::env::temp_dir().join(format!("trem-proxy-{name}-{}.sqlite", std::process::id()));
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", db.display()));
        }
        let cache = HttpCache::open(&db).unwrap();
        // no_proxy: a system proxy would take the request away from the server.
        let client = reqwest::Client::builder()
            .resolve("test.exptech.dev", addr)
            .no_proxy()
            .build()
            .unwrap();
        let state = ProxyState {
            endpoints: Arc::new(Endpoints::new(client.clone())),
            client,
            cache: Arc::new(cache),
            cooldown: Mutex::new(HashMap::new()),
            gates: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
        };
        (state, hits)
    }

    async fn get(state: &ProxyState, path: &str) -> Result<Fetched, String> {
        let url = format!("http://test.exptech.dev{path}");
        let req = ProxyRequest {
            url: url.clone(),
            method: None,
            headers: HashMap::new(),
            timeout_ms: Some(5_000),
            store: Some(true),
            max_age_ms: None,
        };
        let parsed = reqwest::Url::parse(&url).unwrap();
        request(state, req, parsed, "test.exptech.dev".into()).await
    }

    fn http(status: &str, extra: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n{extra}\r\n{body}",
            body.len()
        )
    }

    #[test]
    fn a_5xx_is_retried_with_backoff() {
        let (state, hits) = server("retry", |n, _| {
            if n < 2 {
                http("503 Service Unavailable", "", "busy")
            } else {
                http("200 OK", "", "ok")
            }
        });
        let got = tauri::async_runtime::block_on(get(&state, "/a")).unwrap();
        assert_eq!((got.status, got.body.as_slice()), (200, &b"ok"[..]));
        assert_eq!(hits.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn a_429_cools_the_host_and_a_stored_copy_is_served_meanwhile() {
        let (state, hits) = server("cooldown", |n, _| match n {
            0 => http("200 OK", "etag: \"v1\"\r\n", "first"),
            _ => http("429 Too Many Requests", "retry-after: 30\r\n", "slow down"),
        });
        tauri::async_runtime::block_on(async {
            let first = get(&state, "/b").await.unwrap();
            assert_eq!(first.body.as_slice(), b"first");
            // The body is compressed and queued off this thread; wait for it.
            for _ in 0..50 {
                state.cache.drain();
                if state.cache.get("GET http://test.exptech.dev/b").is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            // Revalidating hits the 429: the stored copy, marked stale.
            let second = get(&state, "/b").await.unwrap();
            assert_eq!(
                (second.body.as_slice(), second.stale),
                (&b"first"[..], true)
            );
            let after_429 = hits.load(Ordering::SeqCst);
            // Cooling down: served from the cache without asking.
            let third = get(&state, "/b").await.unwrap();
            assert_eq!((third.body.as_slice(), third.stale), (&b"first"[..], true));
            assert_eq!(hits.load(Ordering::SeqCst), after_429);
        });
    }

    #[test]
    fn identical_requests_in_flight_share_one_exchange() {
        let (state, hits) = server("flight", |_, _| {
            std::thread::sleep(Duration::from_millis(200));
            http("200 OK", "", "shared")
        });
        tauri::async_runtime::block_on(async {
            let (a, b, c) = tokio::join!(get(&state, "/c"), get(&state, "/c"), get(&state, "/c"));
            for r in [a, b, c] {
                assert_eq!(r.unwrap().body.as_slice(), b"shared");
            }
        });
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

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
