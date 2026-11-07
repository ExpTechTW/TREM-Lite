//! zh-TW speech. The engine keeps the browser's semantics: a queue of utterances, a flush,
//! and a call once each has ended, spoken or cut off. Each utterance carries the app's
//! token `T`, handed back when it ends.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

/// Called with an utterance's token once it has ended, spoken or cut off, from whatever
/// thread the engine ends it on.
pub type Ended<T> = Arc<dyn Fn(T) + Send + Sync>;

struct Queue<T> {
    waiting: VecDeque<(String, T)>,
    speaking: Option<T>,
}

pub struct Speech<T> {
    /// Made on first use, on the main thread like before: it takes ~70 ms on macOS, which
    /// the first frame need not wait for. `warm` makes it once the window is up.
    engine: std::cell::OnceCell<Option<Arc<Mutex<tts::Tts>>>>,
    queue: Arc<Mutex<Queue<T>>>,
    post: Ended<T>,
}

fn say_next<T>(engine: &Mutex<tts::Tts>, queue: &Mutex<Queue<T>>, post: &Ended<T>) {
    let Ok(mut q) = queue.lock() else {
        return;
    };
    if q.speaking.is_some() {
        return;
    }
    let Some((text, end)) = q.waiting.pop_front() else {
        return;
    };
    q.speaking = Some(end);
    drop(q);
    let result = engine.lock().map(|mut e| e.speak(text, false).map(|_| ()));
    if !matches!(result, Ok(Ok(()))) {
        log::warn!(target: "speech", "語音失敗");
        if let Ok(mut q) = queue.lock() {
            if let Some(end) = q.speaking.take() {
                post(end);
            }
        }
    }
}

impl<T: Send + 'static> Speech<T> {
    /// No engine at all, for a screenshot.
    pub fn disabled(post: Ended<T>) -> Self {
        Self {
            engine: std::cell::OnceCell::from(None),
            queue: Arc::new(Mutex::new(Queue {
                waiting: VecDeque::new(),
                speaking: None,
            })),
            post,
        }
    }

    pub fn new(post: Ended<T>) -> Self {
        Self {
            engine: std::cell::OnceCell::new(),
            queue: Arc::new(Mutex::new(Queue {
                waiting: VecDeque::new(),
                speaking: None,
            })),
            post,
        }
    }

    /// Make the engine now, if not yet made.
    pub fn warm(&self) {
        let _ = self.engine();
    }

    fn engine(&self) -> Option<&Arc<Mutex<tts::Tts>>> {
        self.engine
            .get_or_init(|| start_engine(&self.queue, &self.post))
            .as_ref()
    }

    pub fn available(&self) -> bool {
        self.engine().is_some()
    }

    pub fn speak(&mut self, text: &str, queue: bool, end: T) {
        if !queue {
            self.stop();
        }
        let Some(engine) = self.engine() else {
            return;
        };
        if let Ok(mut q) = self.queue.lock() {
            q.waiting.push_back((text.to_string(), end));
        }
        say_next(engine, &self.queue, &self.post);
    }

    pub fn stop(&mut self) {
        // Not made yet: nothing has been said, so nothing to stop.
        let Some(engine) = self.engine.get().and_then(Option::as_ref) else {
            return;
        };
        let mut ended = Vec::new();
        if let Ok(mut q) = self.queue.lock() {
            ended.extend(q.speaking.take());
            ended.extend(q.waiting.drain(..).map(|(_, end)| end));
        }
        if let Ok(mut e) = engine.lock() {
            let _ = e.stop();
        }
        for end in ended {
            (self.post)(end);
        }
    }
}

fn start_engine<T: Send + 'static>(
    queue: &Arc<Mutex<Queue<T>>>,
    post: &Ended<T>,
) -> Option<Arc<Mutex<tts::Tts>>> {
    let engine = match tts::Tts::default() {
        Ok(engine) => Some(Arc::new(Mutex::new(engine))),
        Err(err) => {
            log::warn!(target: "speech", "語音引擎無法使用：{err}");
            None
        }
    };
    if let Some(engine) = &engine {
        if let Ok(mut locked) = engine.lock() {
            pick_voice(&mut locked);
            let done = locked.supported_features().utterance_callbacks;
            if done {
                let (queue_end, engine_end, post_end) =
                    (Arc::clone(queue), Arc::clone(engine), Arc::clone(post));
                let finished = move |_| {
                    let ended = queue_end.lock().ok().and_then(|mut q| q.speaking.take());
                    if let Some(end) = ended {
                        post_end(end);
                    }
                    // Not under the engine's own callback: a new utterance starts freely.
                    let (engine, queue, post) = (
                        Arc::clone(&engine_end),
                        Arc::clone(&queue_end),
                        Arc::clone(&post_end),
                    );
                    std::thread::spawn(move || say_next(&engine, &queue, &post));
                };
                let _ = locked.on_utterance_end(Some(Box::new(finished.clone())));
                let _ = locked.on_utterance_stop(Some(Box::new(finished)));
            }
        }
    }
    engine
}

fn pick_voice(engine: &mut tts::Tts) {
    let Ok(voices) = engine.voices() else {
        return;
    };
    let wanted = voices.iter().find(|v| v.language() == "zh-TW").or_else(|| {
        voices
            .iter()
            .find(|v| v.language().as_str().starts_with("zh"))
    });
    match wanted {
        Some(voice) => {
            if let Err(err) = engine.set_voice(voice) {
                log::warn!(target: "speech", "無法選用語音 {}：{err}", voice.name());
            }
        }
        None => log::warn!(target: "speech", "系統沒有中文語音，用預設語音"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_engine_waits_for_its_first_use() {
        let mut speech = Speech::<()>::new(Arc::new(|_| {}));
        assert!(speech.engine.get().is_none());
        speech.stop();
        assert!(
            speech.engine.get().is_none(),
            "stopping before anything was said makes no engine"
        );
        assert!(!Speech::<()>::disabled(Arc::new(|_| {})).available());
    }
}
