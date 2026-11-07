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
//! * Windows — a process that sets no Quality of Service gets one the system
//!   infers, and EcoQoS runs it at a lower clock or on efficiency cores.
//!   <https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-setprocessinformation>
//! * Linux — nothing to set.

/// What [`keep_awake`] did, for [`log_state`]: it runs before the logger exists.
static STATE: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Writes what [`keep_awake`] did to the log, once the logger is up.
pub fn log_state() {
    match STATE.get() {
        Some(state) => log::info!("背景不降速：{state}"),
        None => log::info!("背景不降速：這個平台沒有可設定的項目"),
    }
}

/// Run first in `main`.
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
        let _ = STATE.set("macOS App Nap 已排除（user-initiated activity）".into());
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
        let qos = unsafe {
            SetProcessInformation(
                GetCurrentProcess(),
                ProcessPowerThrottling,
                std::ptr::from_ref(&state).cast(),
                std::mem::size_of_val(&state) as u32,
            )
        };
        let qos = match qos {
            Ok(()) => "EcoQoS 已排除".to_string(),
            Err(e) => format!("EcoQoS 排除失敗（{e}）"),
        };

        let _ = STATE.set(qos);
    }
}
