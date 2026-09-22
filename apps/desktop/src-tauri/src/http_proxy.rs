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
//! * **LRU persistence** — see [`crate::http_cache`].
//! * **Stale-on-error** — if the network fails outright but we hold a cached
//!   body, the app gets the stale copy rather than nothing.
//!
//! Long-lived responses (SSE) deliberately do *not* come through here; they
//! stay on `tauri-plugin-http`'s streaming `fetch`, since a cache has nothing
//! to offer an infinite stream. The frontend routes those through the same
//! abstraction layer via its `stream()` entry point.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tauri::{Manager, State};
use tauri_plugin_http::reqwest;

use crate::http_cache::{gunzip, CacheEntry, HttpCache, StoredResponse};

/// Hosts the proxy is willing to talk to. Mirrors the `http:default` scope in
/// `capabilities/default.json` (this command bypasses that scope, so the
/// allowlist has to be restated here) plus the map glyph CDN.
const ALLOWED_HOSTS: &[&str] = &[
    "*.exptech.dev",
    "*.exptech.com.tw",
    "raw.githubusercontent.com",
    "www.cwa.gov.tw",
    "cdn.jsdelivr.net",
    "contrib.rocks",
];

/// Response headers worth carrying back to the renderer / storing. Keeping the
/// set small stops per-connection noise (`set-cookie`, `date`, `server`, …)
/// from bloating every cache row.
const KEPT_HEADERS: &[&str] = &[
    "content-type",
    "content-length",
    "etag",
    "last-modified",
    "cache-control",
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

        Ok(Self {
            client,
            cache: Arc::new(cache),
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

    // Read the validator, then release the lock before touching the network.
    let cached = if store {
        cache_get(&state.cache, key.clone()).await
    } else {
        None
    };

    let http_method =
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| format!("bad method: {e}"))?;
    let mut builder = state
        .client
        .request(http_method, parsed.clone())
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

    let response = match builder.send().await {
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

    // 304: the stored body is still current. Bump its LRU position and replay.
    if status == 304 {
        if let Some(entry) = cached {
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStatsPayload {
    entries: i64,
    bytes: i64,
    max_bytes: i64,
}

#[tauri::command]
pub fn http_cache_stats(state: State<'_, ProxyState>) -> Result<CacheStatsPayload, String> {
    let stats = state.cache.stats();
    Ok(CacheStatsPayload {
        entries: stats.entries,
        bytes: stats.bytes,
        max_bytes: stats.max_bytes,
    })
}

#[tauri::command]
pub fn http_cache_clear(state: State<'_, ProxyState>) -> Result<(), String> {
    state.cache.clear();
    Ok(())
}
