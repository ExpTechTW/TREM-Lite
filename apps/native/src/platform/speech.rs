//! zh-TW speech. The engine keeps the browser's semantics: a queue of utterances, a flush,
//! and a call once each has ended, spoken or cut off.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use crate::app::{Msg, Post};
use crate::features::alerts::SpeechEnd;

struct Queue {
    waiting: VecDeque<(String, SpeechEnd)>,
    speaking: Option<SpeechEnd>,
}

pub struct Speech {
    engine: Option<Arc<Mutex<tts::Tts>>>,
    queue: Arc<Mutex<Queue>>,
    post: Post,
}

fn say_next(engine: &Mutex<tts::Tts>, queue: &Mutex<Queue>, post: &Post) {
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
                post(Msg::SpeechEnded(end));
            }
        }
    }
}

impl Speech {
    /// No engine at all, for a screenshot.
    pub fn disabled(post: Post) -> Self {
        Self {
            engine: None,
            queue: Arc::new(Mutex::new(Queue {
                waiting: VecDeque::new(),
                speaking: None,
            })),
            post,
        }
    }

    pub fn new(post: Post) -> Self {
        let queue = Arc::new(Mutex::new(Queue {
            waiting: VecDeque::new(),
            speaking: None,
        }));
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
                        (Arc::clone(&queue), Arc::clone(engine), Arc::clone(&post));
                    let finished = move |_| {
                        let ended = queue_end.lock().ok().and_then(|mut q| q.speaking.take());
                        if let Some(end) = ended {
                            post_end(Msg::SpeechEnded(end));
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
        Self {
            engine,
            queue,
            post,
        }
    }

    pub fn available(&self) -> bool {
        self.engine.is_some()
    }

    pub fn speak(&mut self, text: &str, queue: bool, end: SpeechEnd) {
        if !queue {
            self.stop();
        }
        let Some(engine) = &self.engine else {
            return;
        };
        if let Ok(mut q) = self.queue.lock() {
            q.waiting.push_back((text.to_string(), end));
        }
        say_next(engine, &self.queue, &self.post);
    }

    pub fn stop(&mut self) {
        let Some(engine) = &self.engine else {
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
            (self.post)(Msg::SpeechEnded(end));
        }
    }
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
