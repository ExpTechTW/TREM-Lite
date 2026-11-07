//! What every TREM app computes the same way, with no window, GPU or network: the towns
//! and detection boxes, the travel-time table, intensity levels and their colours, a
//! build's label, the intensity model, and the wire format of ExpTech's SSE streams.
//! The same code runs in a browser (wasm32).

pub mod bindata;
pub mod color;
pub mod fmt;
pub mod intensity;
#[cfg(feature = "ml")]
pub mod ml;
pub mod region;
pub mod sse;
pub mod travel_time;
pub mod version;
