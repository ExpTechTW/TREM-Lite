//! Everything that talks to the network: the caching proxy, regional routing,
//! SSE streams and clock calibration. Fixture mode replaces all of it with files.
//! In a browser, fetch does the requests and the browser keeps the HTTP cache.

#[cfg(not(target_arch = "wasm32"))]
pub mod cache;
#[cfg(not(target_arch = "wasm32"))]
pub mod endpoints;
pub mod fixture;
#[cfg(not(target_arch = "wasm32"))]
pub mod http;
pub mod ntp;
pub mod sse;
pub mod types;
#[cfg(target_arch = "wasm32")]
pub mod web;

#[cfg(not(target_arch = "wasm32"))]
pub use http::ProxyState;
pub use types::{Fetched, ProxyRequest};
#[cfg(target_arch = "wasm32")]
pub use web::ProxyState;

/// Tests drive the async proxy without a global runtime.
#[cfg(test)]
pub fn test_block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("test runtime")
        .block_on(future)
}
