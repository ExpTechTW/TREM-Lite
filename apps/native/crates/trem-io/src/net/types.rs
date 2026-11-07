//! A request and its answer, the same on the desktop and in a browser.

use std::collections::HashMap;
use std::sync::Arc;

#[derive(Clone, Default)]
pub struct ProxyRequest {
    pub url: String,
    pub method: Option<String>,
    pub headers: HashMap<String, String>,
    pub timeout_ms: Option<u64>,
    /// Participate in the SQLite ETag/LRU store. Defaults to true; the 1 Hz
    /// realtime pollers pass false so their never-repeating payloads don't
    /// churn the budget.
    pub store: Option<bool>,
    /// Serve a stored copy without asking the server while it is younger than
    /// this — for content known not to change, whatever its headers say. The
    /// map tiles are the case: sent `no-store`, with a Last-Modified that moves
    /// forward every minute or so, they would otherwise download afresh on
    /// every use.
    pub max_age_ms: Option<u64>,
}

impl ProxyRequest {
    pub fn get(url: impl Into<String>, timeout_ms: u64) -> Self {
        Self {
            url: url.into(),
            timeout_ms: Some(timeout_ms),
            ..Self::default()
        }
    }

    pub fn no_store(mut self) -> Self {
        self.store = Some(false);
        self
    }

    pub fn max_age(mut self, ms: u64) -> Self {
        self.max_age_ms = Some(ms);
        self
    }
}

/// A finished exchange, as every caller of a single flight receives it.
#[derive(Clone)]
pub struct Fetched {
    pub status: u16,
    pub body: Arc<Vec<u8>>,
    pub from_cache: bool,
    pub stale: bool,
    /// Where the answer came from, in the log's words.
    pub via: &'static str,
}

impl Fetched {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}
