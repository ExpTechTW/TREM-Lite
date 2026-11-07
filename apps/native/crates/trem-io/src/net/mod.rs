//! The network's request half: the desktop's caching proxy with its regional routing,
//! the request and answer both platforms share, and fixture mode, which replaces all of
//! it with files. In a browser, fetch does the requests and the browser keeps the HTTP
//! cache.

#[cfg(all(feature = "cache", not(target_arch = "wasm32")))]
pub mod cache;
#[cfg(all(feature = "cache", not(target_arch = "wasm32")))]
pub mod endpoints;
pub mod fixture;
#[cfg(all(feature = "cache", not(target_arch = "wasm32")))]
pub mod http;
pub mod types;
#[cfg(target_arch = "wasm32")]
pub mod web;

#[cfg(all(feature = "cache", not(target_arch = "wasm32")))]
pub use http::{ProxyConfig, ProxyState};
pub use types::{Fetched, ProxyRequest};
#[cfg(target_arch = "wasm32")]
pub use web::ProxyState;

/// Tests drive the async proxy without a global runtime.
#[cfg(all(test, feature = "cache", not(target_arch = "wasm32")))]
pub fn test_block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("test runtime")
        .block_on(future)
}
