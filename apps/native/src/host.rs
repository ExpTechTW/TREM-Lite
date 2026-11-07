//! Everything the app reaches beyond its own state: the network, worker threads, files,
//! and what it makes the person hear and see. A test swaps these for recordings, so the
//! features run unchanged and their effects can be checked.

use std::path::PathBuf;
use std::sync::Arc;

use crate::app::{Msg, Post};
use crate::backend::audio::AudioEngine;
use crate::net::sse::Cancel;
use crate::net::{Fetched, ProxyRequest, ProxyState};

/// How the app is running.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mode {
    /// The network, the speakers, notifications.
    Live,
    /// `TREM_FIXTURE_DIR`: the files answer, and nothing is heard or shown.
    Fixture,
    /// A test: answers from the test, effects recorded, work done in place.
    #[cfg(test)]
    Test,
}

/// What the app makes the person hear and see, apart from its windows.
#[derive(Clone, Debug, PartialEq)]
pub enum Output {
    Enqueue { queue: String, sound: String },
    Play(String),
    ClearQueue(String),
    StopSounds,
    Preview(String),
    Notify { title: String, body: String },
    Speak { text: String, queue: bool },
    StopSpeech,
}

/// A test's network: an answer for each request it is asked.
#[cfg(test)]
pub type FakeNet = Arc<dyn Fn(&ProxyRequest) -> Result<Fetched, String> + Send + Sync>;

pub struct Host {
    pub mode: Mode,
    pub rt: tokio::runtime::Handle,
    pub post: Post,
    /// The HTTP client and cache. Not in a test.
    pub net: Option<Arc<ProxyState>>,
    /// Where the caches, the replay files and the settings tab are kept. Not in a test.
    pub data_dir: Option<PathBuf>,
    audio: Option<AudioEngine>,
    #[cfg(test)]
    pub fake_net: Option<FakeNet>,
    #[cfg(test)]
    pub outputs: Vec<Output>,
}

impl Host {
    pub fn live(rt: tokio::runtime::Handle, post: Post, net: Arc<ProxyState>) -> Self {
        let mode = if crate::net::fixture::active() {
            Mode::Fixture
        } else {
            Mode::Live
        };
        Self {
            mode,
            rt,
            post,
            net: Some(net),
            data_dir: crate::paths::data_dir(),
            audio: (mode == Mode::Live).then(AudioEngine::new),
            #[cfg(test)]
            fake_net: None,
            #[cfg(test)]
            outputs: Vec::new(),
        }
    }

    #[cfg(test)]
    pub fn test(rt: tokio::runtime::Handle, post: Post, fake_net: FakeNet) -> Self {
        Self {
            mode: Mode::Test,
            rt,
            post,
            net: None,
            data_dir: None,
            audio: None,
            fake_net: Some(fake_net),
            outputs: Vec::new(),
        }
    }

    /// The network is real: streams, clock calibration and downloads run.
    pub fn online(&self) -> bool {
        self.mode == Mode::Live
    }

    /// Settings and caches are written to disk.
    pub fn persists(&self) -> bool {
        self.data_dir.is_some()
    }

    pub fn data_file(&self, name: &str) -> Option<PathBuf> {
        self.data_dir.as_ref().map(|d| d.join(name))
    }

    /// Speech is worth asking for: a test records it as if it were spoken.
    pub fn records(&self) -> bool {
        #[cfg(test)]
        if self.mode == Mode::Test {
            return true;
        }
        false
    }

    pub fn output(&mut self, out: Output) {
        match self.mode {
            Mode::Live => {
                let Some(audio) = &self.audio else {
                    return;
                };
                match &out {
                    Output::Enqueue { queue, sound } => audio.enqueue(queue, sound),
                    Output::Play(sound) => audio.play_direct(sound),
                    Output::ClearQueue(queue) => audio.clear(queue),
                    Output::StopSounds => audio.stop_all(),
                    Output::Preview(sound) => audio.preview(sound),
                    Output::Notify { title, body } => {
                        let (title, body) = (title.clone(), body.clone());
                        // Its own thread: a system that never answers strands only this one.
                        let spawned = std::thread::Builder::new()
                            .name("notify".into())
                            .spawn(move || crate::platform::notify::send(&title, &body));
                        if let Err(err) = spawned {
                            log::warn!(target: "notify", "系統通知送不出去：{err}");
                        }
                    }
                    // Speech has its own engine, which the app drives.
                    Output::Speak { .. } | Output::StopSpeech => {}
                }
            }
            // Fixture data is a test: logged, not heard.
            Mode::Fixture => {}
            #[cfg(test)]
            Mode::Test => self.outputs.push(out),
        }
    }

    /// Work off the main thread. Its result comes back as a message.
    pub fn background(&self, work: impl FnOnce() -> Option<Msg> + Send + 'static) {
        #[cfg(test)]
        if self.mode == Mode::Test {
            if let Some(msg) = work() {
                (self.post)(msg);
            }
            return;
        }
        let post = self.post.clone();
        self.rt.spawn_blocking(move || {
            if let Some(msg) = work() {
                post(msg);
            }
        });
    }

    /// One request; `then` reads the answer on the worker and says what to post.
    pub fn fetch(
        &self,
        req: ProxyRequest,
        then: impl FnOnce(Result<Fetched, String>) -> Option<Msg> + Send + 'static,
    ) {
        self.fetch_all(vec![req], None, move |mut answers| {
            then(
                answers
                    .pop()
                    .unwrap_or_else(|| Err("no answer".to_string())),
            )
        });
    }

    /// Several requests at once, answered together in order. A cancelled set posts nothing.
    pub fn fetch_all(
        &self,
        reqs: Vec<ProxyRequest>,
        cancel: Option<Cancel>,
        then: impl FnOnce(Vec<Result<Fetched, String>>) -> Option<Msg> + Send + 'static,
    ) {
        #[cfg(test)]
        if let Some(fake) = &self.fake_net {
            let answers = reqs.iter().map(|r| fake(r)).collect();
            if let Some(msg) = then(answers) {
                (self.post)(msg);
            }
            return;
        }
        let Some(net) = self.net.clone() else {
            return;
        };
        let post = self.post.clone();
        self.rt.spawn(async move {
            let all = futures_util::future::join_all(reqs.into_iter().map(|r| net.send(r)));
            let answers = match cancel {
                Some(cancel) => tokio::select! {
                    () = cancel.cancelled() => return,
                    answers = all => answers,
                },
                None => all.await,
            };
            if let Some(msg) = then(answers) {
                post(msg);
            }
        });
    }
}
