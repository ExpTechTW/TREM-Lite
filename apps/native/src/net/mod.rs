//! Everything that talks to the network: the caching proxy, regional routing,
//! SSE streams and clock calibration. Fixture mode replaces all of it with files.

pub mod cache;
pub mod endpoints;
pub mod fixture;
pub mod http;
pub mod ntp;
pub mod sse;

pub use http::{Fetched, ProxyRequest, ProxyState};

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
