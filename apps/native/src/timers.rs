//! What the features do later: the tasks the main loop's timers (trem_io::timers) fire.

pub use trem_io::timers::TimerId;

/// Everything the features do later.
#[derive(Clone, Debug, PartialEq)]
pub enum Task {
    FocusTick,
    FocusPending,
    EewWaves,
    EewCacheSweep,
    EewRotate,
    LoopBeat,
    LoopInternet,
    ClockSync,
    DataFetch,
    DataSleep,
    IntensityOff,
    LpgmOff,
    ReplayLimit,
    ReplayReturn,
    ReportNewest,
    ReportFull,
    ResourceFetch,
    SpeechTick,
    SpeechDone(String),
    UpdateWait,
    WindowWatch,
    ResizeFit,
}

pub type Timers = trem_io::timers::Timers<Task>;
