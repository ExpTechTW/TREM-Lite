//! The sound effects in a browser: the page's audio elements, with the desktop's rules —
//! four serial queues, priority preemption of what is still waiting, ALERT played twice,
//! clips that bypass the queues, and one preview at a time. The clips are served beside
//! the page, as the web build already serves them.

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

use wasm_bindgen::closure::Closure;
use wasm_bindgen::JsCast;
use web_sys::HtmlAudioElement;

use super::sound::{preempts, volume_for, QUEUES};

#[derive(Default)]
struct Queue {
    pending: VecDeque<String>,
    playing: Option<HtmlAudioElement>,
}

#[derive(Default)]
struct Inner {
    queues: HashMap<&'static str, Queue>,
    direct: Vec<HtmlAudioElement>,
    preview: Option<HtmlAudioElement>,
}

#[derive(Clone)]
pub struct AudioEngine {
    inner: Rc<RefCell<Inner>>,
}

fn clip(sound: &str) -> Option<HtmlAudioElement> {
    let audio = HtmlAudioElement::new_with_src(&format!("audio/{sound}.mp3")).ok()?;
    audio.set_volume(f64::from(volume_for(sound)));
    Some(audio)
}

fn start(audio: &HtmlAudioElement, sound: &str, how: &str) {
    match audio.play() {
        // A page may not play sound before the person has used it: the promise rejects.
        Ok(_) => log::info!(target: "audio", "{how}：{sound}"),
        Err(err) => log::warn!(target: "audio", "{sound} 沒辦法播：{err:?}"),
    }
}

impl AudioEngine {
    pub fn new() -> Self {
        let mut inner = Inner::default();
        for name in QUEUES {
            inner.queues.insert(name, Queue::default());
        }
        Self {
            inner: Rc::new(RefCell::new(inner)),
        }
    }

    pub fn enqueue(&self, queue: &str, sound: &str) {
        {
            let mut inner = self.inner.borrow_mut();
            let Some(state) = inner.queues.get_mut(queue) else {
                log::warn!(target: "audio", "沒有 {queue} 這個佇列，{sound} 不播");
                return;
            };
            let evict = preempts(sound);
            state.pending.retain(|p| !evict.contains(&p.as_str()));
            if sound == "ALERT" {
                state.pending.push_back(sound.to_string());
            }
            state.pending.push_back(sound.to_string());
        }
        self.pump(queue);
    }

    /// The next clip of `queue`, once the one ahead of it has ended.
    fn pump(&self, queue: &str) {
        let (audio, sound) = {
            let mut inner = self.inner.borrow_mut();
            let Some(state) = inner.queues.get_mut(queue) else {
                return;
            };
            if state.playing.as_ref().is_some_and(|a| !a.ended()) {
                return;
            }
            state.playing = None;
            let Some(sound) = state.pending.pop_front() else {
                return;
            };
            let Some(audio) = clip(&sound) else {
                return;
            };
            state.playing = Some(audio.clone());
            (audio, sound)
        };
        let (engine, name) = (self.clone(), queue.to_string());
        let ended = Closure::<dyn FnMut()>::new(move || engine.pump(&name));
        audio.set_onended(Some(ended.as_ref().unchecked_ref()));
        audio.set_onerror(Some(ended.as_ref().unchecked_ref()));
        ended.forget();
        start(&audio, &sound, &format!("{queue} 佇列播放"));
    }

    pub fn play_direct(&self, sound: &str) {
        let Some(audio) = clip(sound) else {
            return;
        };
        start(&audio, sound, "直接播放");
        let mut inner = self.inner.borrow_mut();
        inner.direct.retain(|a| !a.ended());
        inner.direct.push(audio);
    }

    /// Drops what is waiting; the clip playing finishes.
    pub fn clear(&self, queue: &str) {
        if let Some(state) = self.inner.borrow_mut().queues.get_mut(queue) {
            state.pending.clear();
        }
    }

    pub fn stop_all(&self) {
        let mut inner = self.inner.borrow_mut();
        for state in inner.queues.values_mut() {
            state.pending.clear();
            if let Some(audio) = state.playing.take() {
                let _ = audio.pause();
            }
        }
        for audio in inner.direct.drain(..) {
            let _ = audio.pause();
        }
        if let Some(audio) = inner.preview.take() {
            let _ = audio.pause();
        }
    }

    pub fn preview(&self, sound: &str) {
        let Some(audio) = clip(sound) else {
            return;
        };
        if let Some(before) = self.inner.borrow_mut().preview.replace(audio.clone()) {
            let _ = before.pause();
        }
        start(&audio, sound, "試聽");
    }
}
