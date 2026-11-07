//! What a TREM app does beyond its own state, short of drawing: where async work runs,
//! the main loop's timers, the caching HTTP proxy with its regional routing and fixture
//! mode, the log files, and where the files are kept. The desktop and a browser (wasm32)
//! each get their own half where they differ.

pub mod exec;
pub mod logging;
pub mod net;
pub mod paths;
pub mod timers;
