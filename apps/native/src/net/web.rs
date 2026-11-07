//! The network in a browser: fetch does the requests, and the browser keeps the HTTP cache,
//! so there is no store, no regional routing and no single flight of our own.

use std::sync::Arc;
use std::time::Duration;

use crate::net::{Fetched, ProxyRequest};

pub struct ProxyState {
    client: reqwest::Client,
}

impl ProxyState {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }

    pub fn client(&self) -> reqwest::Client {
        self.client.clone()
    }

    /// The desktop picks a regional node; a browser asks the address it is given.
    pub fn resolve(&self, url: &str) -> Result<String, String> {
        Ok(url.to_string())
    }

    pub fn report(&self, _url: &str, _ok: bool) {}

    pub async fn send(&self, req: ProxyRequest) -> Result<Fetched, String> {
        let method = req
            .method
            .as_deref()
            .unwrap_or("GET")
            .parse::<reqwest::Method>()
            .map_err(|e| e.to_string())?;
        let mut builder = self.client.request(method, &req.url);
        for (name, value) in &req.headers {
            builder = builder.header(name, value);
        }
        if let Some(ms) = req.timeout_ms {
            builder = builder.timeout(Duration::from_millis(ms));
        }
        let response = builder.send().await.map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let body = response.bytes().await.map_err(|e| e.to_string())?;
        Ok(Fetched {
            status,
            body: Arc::new(body.to_vec()),
            from_cache: false,
            stale: false,
            via: "瀏覽器",
        })
    }
}
