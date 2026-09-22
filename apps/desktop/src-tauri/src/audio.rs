//! All sound-effect playback lives in Rust (rodio), never in the WebView.
//!
//! Why: when the WebView (WebView2 / WKWebView) plays audio, OBS window capture
//! grabs it abnormally. Routing every clip through this native engine keeps the
//! audio bound to the app process instead of the WebView.
//!
//! This faithfully ports the behavior of the old `src/js/index/core/audio.js`:
//!   * 4 independent serial queues: `eew`, `pga`, `shindo`, `update`.
//!     Each queue plays one clip at a time (FIFO); different queues overlap.
//!   * In-queue priority preemption removes *pending* lower-priority clips.
//!   * Some clips bypass the queues and play immediately (may overlap):
//!     REPORT, INTENSITY, TSUNAMI.
//!   * `ALERT` is enqueued twice (double-play).
//!   * Per-clip volume: SHINDO0 = 0.4, UPDATE = 0.2, everything else = 1.0.

use std::collections::{HashMap, VecDeque};
use std::io::Cursor;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink};

/// The 12 bundled clips, embedded straight into the binary (~580 KB total).
fn sound_bytes(name: &str) -> Option<&'static [u8]> {
    let bytes: &'static [u8] = match name {
        "ALERT" => include_bytes!("../audio/ALERT.mp3"),
        "EEW" => include_bytes!("../audio/EEW.mp3"),
        "UPDATE" => include_bytes!("../audio/UPDATE.mp3"),
        "CANCEL" => include_bytes!("../audio/CANCEL.mp3"),
        "PGA1" => include_bytes!("../audio/PGA1.mp3"),
        "PGA2" => include_bytes!("../audio/PGA2.mp3"),
        "SHINDO0" => include_bytes!("../audio/SHINDO0.mp3"),
        "SHINDO1" => include_bytes!("../audio/SHINDO1.mp3"),
        "SHINDO2" => include_bytes!("../audio/SHINDO2.mp3"),
        "INTENSITY" => include_bytes!("../audio/INTENSITY.mp3"),
        "REPORT" => include_bytes!("../audio/REPORT.mp3"),
        "TSUNAMI" => include_bytes!("../audio/TSUNAMI.mp3"),
        _ => return None,
    };
    Some(bytes)
}

/// Per-clip volume (mirrors constant.js overrides).
fn volume_for(name: &str) -> f32 {
    match name {
        "SHINDO0" => 0.4,
        "UPDATE" => 0.2,
        _ => 1.0,
    }
}

/// Which pending clips a newly enqueued clip evicts from its queue.
/// Mirrors `priorityRules` in audio.js:104-116.
fn preempts(sound: &str) -> &'static [&'static str] {
    match sound {
        "PGA2" => &["PGA1", "PGA0"],
        "PGA1" => &["PGA0"],
        "SHINDO2" => &["SHINDO1", "SHINDO0"],
        "SHINDO1" => &["SHINDO0"],
        "ALERT" => &["EEW"],
        _ => &[],
    }
}

const QUEUES: [&str; 4] = ["eew", "pga", "shindo", "update"];

/// How often a queue with a clip waiting checks whether the one ahead of it
/// has finished.
const PUMP: Duration = Duration::from_millis(30);

/// Commands that arrive within this long of each other are handled together,
/// up to [`BATCH_MAX`] after the first. See `run_audio_thread`.
const BATCH_QUIET: Duration = Duration::from_millis(10);
const BATCH_MAX: Duration = Duration::from_millis(30);

enum AudioCommand {
    /// Add a clip to a named serial queue (with priority preemption).
    Enqueue { queue: String, sound: String },
    /// Play a clip immediately, bypassing the queues (may overlap).
    PlayDirect { sound: String },
    /// Drop all *pending* clips in a queue (does not stop the current clip).
    Clear { queue: String },
    /// Stop everything and empty every queue.
    StopAll,
}

struct QueueState {
    sink: Sink,
    pending: VecDeque<String>,
}

/// Handle held in Tauri state; forwards commands to the dedicated audio thread.
#[derive(Clone)]
pub struct AudioEngine {
    tx: Sender<AudioCommand>,
}

impl AudioEngine {
    /// Spawns the audio thread that owns the output stream + sinks.
    /// rodio's stream is not `Send`, so it lives entirely on this thread and we
    /// talk to it over an mpsc channel.
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel::<AudioCommand>();
        thread::Builder::new()
            .name("trem-audio".into())
            .spawn(move || run_audio_thread(rx))
            .expect("failed to spawn audio thread");
        AudioEngine { tx }
    }

    pub fn enqueue(&self, queue: &str, sound: &str) {
        let _ = self.tx.send(AudioCommand::Enqueue {
            queue: queue.to_string(),
            sound: sound.to_string(),
        });
    }

    pub fn play_direct(&self, sound: &str) {
        let _ = self.tx.send(AudioCommand::PlayDirect {
            sound: sound.to_string(),
        });
    }

    pub fn clear(&self, queue: &str) {
        let _ = self.tx.send(AudioCommand::Clear {
            queue: queue.to_string(),
        });
    }

    pub fn stop_all(&self) {
        let _ = self.tx.send(AudioCommand::StopAll);
    }
}

fn run_audio_thread(rx: Receiver<AudioCommand>) {
    // Keep `_stream` alive for the whole thread lifetime — dropping it kills audio.
    let (_stream, handle) = match OutputStream::try_default() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[audio] no output device: {e}");
            // Drain commands so senders never block, but we cannot play anything.
            while rx.recv().is_ok() {}
            return;
        }
    };

    let mut queues: HashMap<&'static str, QueueState> = HashMap::new();
    for &q in QUEUES.iter() {
        if let Ok(sink) = Sink::try_new(&handle) {
            queues.insert(
                q,
                QueueState {
                    sink,
                    pending: VecDeque::new(),
                },
            );
        }
    }

    loop {
        // Wait for the next command — indefinitely while no clip is waiting on
        // another to finish, since then there is nothing to pump. This thread
        // used to wake every 30 ms for the life of the app, clip or no clip.
        let waiting = queues.values().any(|q| !q.pending.is_empty());
        let first = if waiting {
            match rx.recv_timeout(PUMP) {
                Ok(cmd) => Some(cmd),
                Err(mpsc::RecvTimeoutError::Timeout) => None,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        } else {
            match rx.recv() {
                Ok(cmd) => Some(cmd),
                Err(_) => return,
            }
        };

        if let Some(cmd) = first {
            handle_command(cmd, &handle, &mut queues);
            // Commands sent together are handled together, so a later one can
            // still evict an earlier one before it starts — RtsShindo2 dropping
            // RtsShindo1 from the same RTS frame. The 30 ms poll this replaces
            // did that by accident, for commands inside one tick; this gathers
            // until the channel has been quiet for BATCH_QUIET, never past the
            // old poll's worst case.
            let until = Instant::now() + BATCH_MAX;
            loop {
                let left = until.saturating_duration_since(Instant::now());
                match rx.recv_timeout(BATCH_QUIET.min(left)) {
                    Ok(cmd) => handle_command(cmd, &handle, &mut queues),
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
        }

        // Advance each queue: if the sink finished, start the next pending clip.
        for state in queues.values_mut() {
            if state.sink.empty() {
                if let Some(sound) = state.pending.pop_front() {
                    play_clip(&state.sink, &sound);
                }
            }
        }
    }
}

fn handle_command(
    cmd: AudioCommand,
    handle: &OutputStreamHandle,
    queues: &mut HashMap<&'static str, QueueState>,
) {
    match cmd {
        AudioCommand::Enqueue { queue, sound } => {
            // Unknown queue name → get_mut returns None (same as Clear below).
            if let Some(state) = queues.get_mut(queue.as_str()) {
                // Evict pending lower-priority clips this clip preempts.
                let evict = preempts(&sound);
                if !evict.is_empty() {
                    state.pending.retain(|p| !evict.contains(&p.as_str()));
                }
                // ALERT double-plays (audio.js:44-47).
                if sound == "ALERT" {
                    state.pending.push_back(sound.clone());
                }
                state.pending.push_back(sound);
            }
        }
        AudioCommand::PlayDirect { sound } => {
            if let Ok(sink) = Sink::try_new(handle) {
                play_clip(&sink, &sound);
                // Detach so it plays to completion independently (overlaps allowed).
                sink.detach();
            }
        }
        AudioCommand::Clear { queue } => {
            if let Some(state) = queues.get_mut(queue.as_str()) {
                state.pending.clear();
            }
        }
        AudioCommand::StopAll => {
            for state in queues.values_mut() {
                state.pending.clear();
                state.sink.stop();
            }
        }
    }
}

fn decode(sound: &str) -> Option<Decoder<Cursor<&'static [u8]>>> {
    let bytes = sound_bytes(sound)?;
    Decoder::new(Cursor::new(bytes)).ok()
}

/// Decode `sound` and start it on `sink` at its per-clip volume (no-op if unknown).
fn play_clip(sink: &Sink, sound: &str) {
    if let Some(source) = decode(sound) {
        sink.set_volume(volume_for(sound));
        sink.append(source);
        sink.play();
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn audio_enqueue(engine: tauri::State<'_, AudioEngine>, queue: String, sound: String) {
    engine.enqueue(&queue, &sound);
}

#[tauri::command]
pub fn audio_play(engine: tauri::State<'_, AudioEngine>, sound: String) {
    engine.play_direct(&sound);
}

#[tauri::command]
pub fn audio_clear(engine: tauri::State<'_, AudioEngine>, queue: String) {
    engine.clear(&queue);
}

#[tauri::command]
pub fn audio_stop_all(engine: tauri::State<'_, AudioEngine>) {
    engine.stop_all();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alert_preempts_eew_and_double_plays() {
        // Exercises the queue's preemption + double-play logic on the pending
        // VecDeque directly (no real sink needed).
        let mut pending: VecDeque<String> = VecDeque::new();
        pending.push_back("EEW".into());

        // Simulate ALERT enqueue.
        let evict = preempts("ALERT");
        pending.retain(|p| !evict.contains(&p.as_str()));
        pending.push_back("ALERT".into());
        pending.push_back("ALERT".into());

        assert_eq!(
            pending,
            VecDeque::from(vec!["ALERT".to_string(), "ALERT".to_string()])
        );
    }

    #[test]
    fn pga2_evicts_pending_pga1() {
        let mut pending: VecDeque<String> = VecDeque::from(vec!["PGA1".to_string()]);
        let evict = preempts("PGA2");
        pending.retain(|p| !evict.contains(&p.as_str()));
        pending.push_back("PGA2".into());
        assert_eq!(pending, VecDeque::from(vec!["PGA2".to_string()]));
    }

    #[test]
    fn volumes_match_source() {
        assert_eq!(volume_for("SHINDO0"), 0.4);
        assert_eq!(volume_for("UPDATE"), 0.2);
        assert_eq!(volume_for("ALERT"), 1.0);
    }

    #[test]
    fn every_sound_decodes() {
        for name in [
            "ALERT",
            "EEW",
            "UPDATE",
            "CANCEL",
            "PGA1",
            "PGA2",
            "SHINDO0",
            "SHINDO1",
            "SHINDO2",
            "INTENSITY",
            "REPORT",
            "TSUNAMI",
        ] {
            assert!(decode(name).is_some(), "failed to decode {name}");
        }
    }
}
