//! The network beyond trem_io's proxy: the SSE streams and clock calibration. Fixture
//! mode replaces all of it with files.

pub mod ntp;
pub mod sse;

/// The proxy's name, and the hosts it may talk to: what the app actually requests
/// through it, the ExpTech APIs and map tiles. (A CWA report page is opened in the
/// browser; it does not come through here.)
#[cfg(not(target_arch = "wasm32"))]
pub fn proxy_config() -> trem_io::net::ProxyConfig {
    trem_io::net::ProxyConfig {
        user_agent: concat!("TREM-Lite/", env!("CARGO_PKG_VERSION")).to_string(),
        allowed_hosts: &["*.exptech.dev", "*.exptech.com.tw", "cdn.jsdelivr.net"],
    }
}
