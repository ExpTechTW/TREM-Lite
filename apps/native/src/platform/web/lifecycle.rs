//! A browser tab has no login item, dock or memory to hand back: what is left is the
//! clipboard and the user agent.

pub fn set_autostart(_on: bool) -> Result<(), String> {
    Err("瀏覽器版沒有開機自動啟動".to_string())
}

pub fn sync_autostart(_on: bool) {}

pub fn system_description() -> String {
    web_sys::window()
        .and_then(|w| w.navigator().user_agent().ok())
        .unwrap_or_else(|| "瀏覽器".to_string())
}

pub fn copy_text(text: &str) -> Result<(), String> {
    let window = web_sys::window().ok_or("沒有 window")?;
    // The promise settles later; a refusal shows in the console.
    let _ = window.navigator().clipboard().write_text(text);
    Ok(())
}

pub fn set_dock(_visible: bool) {}

pub fn activate_app() {}

pub fn pin_to_all_spaces(_window: &winit::window::Window) {}

pub fn return_free_memory() {}
