//! The browser build's start: log to the console, ask for WebGPU, then run the same app
//! as the desktop in the page's canvas.

use winit::event_loop::EventLoop;

use crate::app::Msg;

pub fn start() {
    crate::backend::logging::init();
    log::info!(target: "app", "瀏覽器版啟動");
    let event_loop = match EventLoop::<Msg>::with_user_event().build() {
        Ok(event_loop) => event_loop,
        Err(err) => {
            show_message(&format!("無法建立事件迴圈：{err}"));
            return;
        }
    };
    // Asking for the GPU takes awaiting; the event loop starts once it has answered.
    wasm_bindgen_futures::spawn_local(async move {
        match crate::render::Gpu::new_web().await {
            Some(gpu) => {
                hide_message();
                crate::runner::run_web(event_loop, gpu);
            }
            None => show_message(
                "這個瀏覽器不支援 WebGPU，畫不出畫面。請用 Chrome、Edge、Safari 26 以上，或 Windows 上的 Firefox 141 以上。",
            ),
        }
    });
}

/// A line of text in place of the app, for when it cannot start.
fn show_message(text: &str) {
    log::error!(target: "app", "{text}");
    if let Some(element) = web_sys::window()
        .and_then(|w| w.document())
        .and_then(|d| d.get_element_by_id("status"))
    {
        element.set_text_content(Some(text));
    }
}

fn hide_message() {
    if let Some(element) = web_sys::window()
        .and_then(|w| w.document())
        .and_then(|d| d.get_element_by_id("status"))
    {
        element.remove();
    }
}
