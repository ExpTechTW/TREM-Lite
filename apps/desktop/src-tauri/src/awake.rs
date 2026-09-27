//! Keeps the app at full speed while its windows are hidden: an earthquake
//! alert comes in, and has to be heard, while the app sits in the tray.
//!
//! What slows a hidden app down, and what is done about it here:
//!
//! * macOS — App Nap lowers the process's priority and fires its timers late
//!   (the audio thread's 10 ms batch window among them). A user-initiated
//!   activity keeps the app out of App Nap and still lets the Mac sleep when
//!   idle.
//!   <https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/PrioritizeWorkAtTheAppLevel.html>
//!   The web views are WebKit's to schedule: `backgroundThrottling` in
//!   tauri.conf.json (main) and lib/windows.ts (PiP), from macOS 14.
//! * Windows — a process that sets no Quality of Service gets one the system
//!   infers, and EcoQoS runs it at a lower clock or on efficiency cores.
//!   <https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-setprocessinformation>
//!   WebView2 is Chromium, which slows the timers of a page out of sight and
//!   lowers its renderer's priority; three switches turn that off. They go in
//!   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, which WebView2 appends to every
//!   web view's own arguments: the settings and PiP windows are opened from
//!   JS, and web views sharing a browser process must all be created with the
//!   same options, or creating one fails.
//!   <https://learn.microsoft.com/microsoft-edge/webview2/reference/win32/webview2-idl#createcorewebview2environmentwithoptions>
//! * Linux — Tauri's `backgroundThrottling` does nothing on WebKitGTK, and
//!   nothing here stands in for it.

/// Chromium's switches for a page that is hidden, minimised or covered.
#[cfg(windows)]
const WEBVIEW2_SWITCHES: &str = "--disable-background-timer-throttling \
     --disable-renderer-backgrounding --disable-backgrounding-occluded-windows";
/// Read by WebView2 each time a web view is created.
#[cfg(windows)]
const WEBVIEW2_ARGS_VAR: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";

/// Run first in `run()`: the environment variable must be in place before any
/// other thread or any web view exists.
pub fn keep_awake() {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{ns_string, NSActivityOptions, NSProcessInfo};
        let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
            NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
            ns_string!("Earthquake alerts while the window is hidden"),
        );
        // Held for the app's life: ending it would let App Nap back in.
        std::mem::forget(activity);
    }

    #[cfg(windows)]
    {
        use windows::Win32::System::Threading::{
            GetCurrentProcess, ProcessPowerThrottling, SetProcessInformation,
            PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
            PROCESS_POWER_THROTTLING_STATE,
        };
        // The mechanism named in ControlMask, and off in StateMask: HighQoS.
        let state = PROCESS_POWER_THROTTLING_STATE {
            Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
            StateMask: 0,
        };
        // SAFETY: ProcessPowerThrottling takes a PROCESS_POWER_THROTTLING_STATE
        // and its size; `state` is one, alive for the call. It fails only where
        // Windows has no power throttling to opt out of.
        let _ = unsafe {
            SetProcessInformation(
                GetCurrentProcess(),
                ProcessPowerThrottling,
                std::ptr::from_ref(&state).cast(),
                std::mem::size_of_val(&state) as u32,
            )
        };

        let args = match std::env::var(WEBVIEW2_ARGS_VAR) {
            // Inherited from the copy of the app that started this one.
            Ok(set) if set.contains(WEBVIEW2_SWITCHES) => return,
            Ok(set) if !set.trim().is_empty() => format!("{set} {WEBVIEW2_SWITCHES}"),
            _ => WEBVIEW2_SWITCHES.to_string(),
        };
        std::env::set_var(WEBVIEW2_ARGS_VAR, args);
    }
}
