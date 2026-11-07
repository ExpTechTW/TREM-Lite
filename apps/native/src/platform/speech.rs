//! zh-TW speech: trem_gfx's engine, telling the app as each utterance ends.

use std::sync::Arc;

use crate::app::{Msg, Post};
use crate::features::alerts::SpeechEnd;

pub type Speech = trem_gfx::platform::speech::Speech<SpeechEnd>;

fn ended(post: Post) -> trem_gfx::platform::speech::Ended<SpeechEnd> {
    Arc::new(move |end| post(Msg::SpeechEnded(end)))
}

pub fn new(post: Post) -> Speech {
    Speech::new(ended(post))
}

/// No engine at all, for a screenshot.
pub fn disabled(post: Post) -> Speech {
    Speech::disabled(ended(post))
}
