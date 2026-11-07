//! zh-TW speech through the page's speechSynthesis: a queue of utterances, a flush, and a
//! message once each has ended, spoken or cut off, as on the desktop.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;

use wasm_bindgen::closure::Closure;
use wasm_bindgen::JsCast;
use web_sys::{SpeechSynthesis, SpeechSynthesisUtterance};

/// Called with an utterance's token once it has ended, spoken or cut off.
pub type Ended<T> = std::sync::Arc<dyn Fn(T) + Send + Sync>;

struct Queue<T> {
    waiting: VecDeque<(String, T)>,
    /// The utterance being said, by number: a cancelled one ends later, and must not
    /// take the next one's place.
    speaking: Option<(u64, T)>,
    next: u64,
}

impl<T> Default for Queue<T> {
    fn default() -> Self {
        Self {
            waiting: VecDeque::new(),
            speaking: None,
            next: 0,
        }
    }
}

pub struct Speech<T> {
    synth: Option<SpeechSynthesis>,
    queue: Rc<RefCell<Queue<T>>>,
    post: Ended<T>,
}

fn say_next<T: 'static>(synth: &SpeechSynthesis, queue: &Rc<RefCell<Queue<T>>>, post: &Ended<T>) {
    let (id, text) = {
        let mut q = queue.borrow_mut();
        if q.speaking.is_some() {
            return;
        }
        let Some((text, end)) = q.waiting.pop_front() else {
            return;
        };
        q.next += 1;
        let id = q.next;
        q.speaking = Some((id, end));
        (id, text)
    };
    let Ok(utterance) = SpeechSynthesisUtterance::new_with_text(&text) else {
        log::warn!(target: "speech", "語音失敗");
        if let Some((_, end)) = queue.borrow_mut().speaking.take() {
            post(end);
        }
        return;
    };
    utterance.set_lang("zh-TW");
    let (synth_end, queue_end, post_end) = (synth.clone(), Rc::clone(queue), post.clone());
    let finished = Closure::<dyn FnMut()>::new(move || {
        let ended = {
            let mut q = queue_end.borrow_mut();
            match q.speaking {
                Some((current, _)) if current == id => q.speaking.take().map(|(_, end)| end),
                _ => None,
            }
        };
        if let Some(end) = ended {
            post_end(end);
            say_next(&synth_end, &queue_end, &post_end);
        }
    });
    utterance.set_onend(Some(finished.as_ref().unchecked_ref()));
    utterance.set_onerror(Some(finished.as_ref().unchecked_ref()));
    // Each utterance ends once; the closure lives as long as the page.
    finished.forget();
    synth.speak(&utterance);
}

impl<T: 'static> Speech<T> {
    pub fn disabled(post: Ended<T>) -> Self {
        Self {
            synth: None,
            queue: Rc::default(),
            post,
        }
    }

    pub fn new(post: Ended<T>) -> Self {
        let synth = web_sys::window().and_then(|w| w.speech_synthesis().ok());
        if synth.is_none() {
            log::warn!(target: "speech", "這個瀏覽器沒有語音合成");
        }
        Self {
            synth,
            queue: Rc::default(),
            post,
        }
    }

    pub fn warm(&self) {}

    pub fn available(&self) -> bool {
        self.synth.is_some()
    }

    pub fn speak(&mut self, text: &str, queue: bool, end: T) {
        if !queue {
            self.stop();
        }
        let Some(synth) = &self.synth else {
            return;
        };
        self.queue
            .borrow_mut()
            .waiting
            .push_back((text.to_string(), end));
        say_next(synth, &self.queue, &self.post);
    }

    pub fn stop(&mut self) {
        let Some(synth) = &self.synth else {
            return;
        };
        let ended: Vec<T> = {
            let mut q = self.queue.borrow_mut();
            q.speaking
                .take()
                .map(|(_, end)| end)
                .into_iter()
                .chain(q.waiting.drain(..).map(|(_, end)| end))
                .collect()
        };
        synth.cancel();
        for end in ended {
            (self.post)(end);
        }
    }
}
