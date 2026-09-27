//! Clock calibration: the offset (server − local, ms) that turns the local clock
//! into the app's standard time (packages/core/src/lib/ntp.ts).
//!
//! SNTP against ExpTech's time server first; if UDP 123 is blocked or the
//! server does not answer, the same exchange over HTTPS — `lb.exptech.dev/ntp`
//! stamps its receive and transmit times in `x-ntp-t2` / `x-ntp-t3`. Either
//! way the offset is the NTP one, ((t2 − t1) + (t3 − t4)) / 2, which cancels a
//! symmetric network delay; the web build computes it the same way.

use std::net::UdpSocket;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri_plugin_http::reqwest;

/// Seconds between the NTP epoch (1900-01-01) and the Unix epoch (1970-01-01).
const NTP_UNIX_DELTA: f64 = 2_208_988_800.0;
const SNTP_SERVER: &str = "time.exptech.com.tw";
const HTTP_SERVER: &str = "https://lb.exptech.dev/ntp";
const TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Serialize)]
pub struct NtpResult {
    /// server − local, in milliseconds. Add this to `Date.now()` for standard time.
    pub offset_ms: f64,
    /// The round trip, less the server's own time (ms).
    pub rtt_ms: f64,
    /// Which exchange answered: "sntp" or "http".
    pub via: &'static str,
}

fn unix_ms(t: SystemTime) -> f64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn result(t1: f64, t2: f64, t3: f64, t4: f64, via: &'static str) -> NtpResult {
    NtpResult {
        offset_ms: ((t2 - t1) + (t3 - t4)) / 2.0,
        rtt_ms: (t4 - t1) - (t3 - t2),
        via,
    }
}

fn sntp() -> Result<NtpResult, String> {
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    socket
        .set_read_timeout(Some(TIMEOUT))
        .map_err(|e| e.to_string())?;
    // 48-byte request; first byte = LI 0, VN 3, Mode 3 (client).
    let mut packet = [0u8; 48];
    packet[0] = 0x1B;
    let t1 = unix_ms(SystemTime::now());
    socket
        .send_to(&packet, (SNTP_SERVER, 123))
        .map_err(|e| format!("send {SNTP_SERVER}: {e}"))?;
    let mut buf = [0u8; 48];
    socket
        .recv_from(&mut buf)
        .map_err(|e| format!("recv {SNTP_SERVER}: {e}"))?;
    let t4 = unix_ms(SystemTime::now());
    // Receive (32..40) and transmit (40..48) timestamps: seconds, then fraction.
    let stamp = |at: usize| {
        let secs = u32::from_be_bytes(buf[at..at + 4].try_into().unwrap());
        let frac = u32::from_be_bytes(buf[at + 4..at + 8].try_into().unwrap());
        (f64::from(secs) - NTP_UNIX_DELTA + f64::from(frac) / 4_294_967_296.0) * 1000.0
    };
    if buf[40..44] == [0; 4] {
        return Err("invalid SNTP response".into());
    }
    Ok(result(t1, stamp(32), stamp(40), t4, "sntp"))
}

async fn http(client: &reqwest::Client) -> Result<NtpResult, String> {
    let t1 = unix_ms(SystemTime::now());
    let res = client
        .get(HTTP_SERVER)
        .timeout(TIMEOUT)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let t4 = unix_ms(SystemTime::now());
    let header = |name: &str| {
        res.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<f64>().ok())
    };
    let (Some(t2), Some(t3)) = (header("x-ntp-t2"), header("x-ntp-t3")) else {
        return Err(format!("{HTTP_SERVER}: no x-ntp-t2 / x-ntp-t3"));
    };
    Ok(result(t1, t2, t3, t4, "http"))
}

#[tauri::command]
pub async fn ntp_sync() -> Result<NtpResult, String> {
    let udp = tauri::async_runtime::spawn_blocking(sntp)
        .await
        .map_err(|e| e.to_string())?;
    match udp {
        Ok(r) => Ok(r),
        Err(e) => {
            log::debug!("SNTP failed ({e}), trying HTTP");
            http(&reqwest::Client::new()).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::result;

    #[test]
    fn offset_cancels_a_symmetric_delay() {
        // Server 500 ms ahead, 40 ms each way, 2 ms inside the server.
        let r = result(1000.0, 1540.0, 1542.0, 1082.0, "sntp");
        assert_eq!(r.offset_ms, 500.0);
        assert_eq!(r.rtt_ms, 80.0);
    }
}
