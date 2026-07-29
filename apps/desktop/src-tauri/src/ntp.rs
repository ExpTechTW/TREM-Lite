//! Minimal SNTP client — replaces the Node-only `ntp-time-sync` used by loop.js.
//! Returns the clock offset (server − local) in milliseconds so the frontend can
//! compute a corrected "now" without depending on the local clock.

use std::net::UdpSocket;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// Seconds between the NTP epoch (1900-01-01) and the Unix epoch (1970-01-01).
const NTP_UNIX_DELTA: u64 = 2_208_988_800;

#[derive(Serialize)]
pub struct NtpResult {
    /// server − local, in milliseconds. Add this to `Date.now()` for corrected time.
    pub offset_ms: i64,
    /// The synced wall-clock time in Unix milliseconds.
    pub now_ms: i64,
}

fn query(server: &str) -> Result<NtpResult, String> {
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    socket
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
    socket
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;

    // 48-byte SNTP request; first byte = LI 0, VN 3, Mode 3 (client).
    let mut packet = [0u8; 48];
    packet[0] = 0x1B;

    let t1 = SystemTime::now();
    socket
        .send_to(&packet, (server, 123))
        .map_err(|e| format!("send {server}: {e}"))?;

    let mut buf = [0u8; 48];
    socket
        .recv_from(&mut buf)
        .map_err(|e| format!("recv {server}: {e}"))?;
    let t4 = SystemTime::now();

    // Transmit timestamp: bytes 40..44 seconds, 44..48 fraction.
    let secs = u32::from_be_bytes([buf[40], buf[41], buf[42], buf[43]]) as u64;
    let frac = u32::from_be_bytes([buf[44], buf[45], buf[46], buf[47]]) as u64;
    if secs == 0 {
        return Err("invalid NTP response".into());
    }
    let server_ms = (secs - NTP_UNIX_DELTA) * 1000 + (frac * 1000) / (1u64 << 32);

    // Approximate local time at the midpoint of the round trip.
    let local_mid_ms = {
        let a = t1.duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as i64;
        let b = t4.duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as i64;
        (a + b) / 2
    };

    let offset_ms = server_ms as i64 - local_mid_ms;
    Ok(NtpResult {
        offset_ms,
        now_ms: server_ms as i64,
    })
}

/// Try a few well-known pools; return the first that answers.
#[tauri::command]
pub async fn ntp_sync() -> Result<NtpResult, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let servers = ["time.google.com", "pool.ntp.org", "time.cloudflare.com"];
        let mut last_err = String::from("no server tried");
        for s in servers {
            match query(s) {
                Ok(r) => return Ok(r),
                Err(e) => last_err = e,
            }
        }
        Err(last_err)
    })
    .await
    .map_err(|e| e.to_string())?
}
