//! The event bus's events (lib/types.ts `TremEvents`). Dispatch is synchronous and in
//! the modules' registration order (`app::MODULES`), as mitt's was.

use std::rc::Rc;

use crate::domain::types::{EewData, IntensityReport, LpgmData, ReportListItem, RtsData};

#[derive(Clone, Debug)]
pub enum Event {
    MapLoad,
    FocusLockChange(bool),
    EewDisplayUpdate,
    InternetErrorChange(bool),
    UpdateReady(String),
    MainWindowHidden(bool),

    DataRts(Option<Rc<RtsData>>),
    DataModeReset,

    EewRelease(Rc<EewData>),
    EewUpdate(Rc<EewData>),
    EewEnd(Rc<EewData>),
    EewAlert(Rc<EewData>),
    EewCancel(Rc<EewData>),
    EewNewAreaAlert(Rc<Vec<String>>),

    IntensityRelease(Rc<IntensityReport>),
    IntensityUpdate(Rc<IntensityReport>),
    IntensityEnd(Rc<IntensityReport>),

    LpgmRelease(Rc<LpgmData>),

    ReportRelease {
        data: Rc<ReportListItem>,
        update: bool,
    },
    ReportSpeechEnd(String),
    ReportListUpdate,
    ReplayStateChange {
        active: bool,
        report_id: Option<String>,
    },

    RtsPga1,
    RtsPga2,
    RtsShindo0,
    RtsShindo1,
    RtsShindo2,
}

impl Event {
    pub fn name(&self) -> &'static str {
        match self {
            Self::MapLoad => "MapLoad",
            Self::FocusLockChange(_) => "FocusLockChange",
            Self::EewDisplayUpdate => "EewDisplayUpdate",
            Self::InternetErrorChange(_) => "InternetErrorChange",
            Self::UpdateReady(_) => "UpdateReady",
            Self::MainWindowHidden(_) => "MainWindowHidden",
            Self::DataRts(_) => "DataRts",
            Self::DataModeReset => "DataModeReset",
            Self::EewRelease(_) => "EewRelease",
            Self::EewUpdate(_) => "EewUpdate",
            Self::EewEnd(_) => "EewEnd",
            Self::EewAlert(_) => "EewAlert",
            Self::EewCancel(_) => "EewCancel",
            Self::EewNewAreaAlert(_) => "EewNewAreaAlert",
            Self::IntensityRelease(_) => "IntensityRelease",
            Self::IntensityUpdate(_) => "IntensityUpdate",
            Self::IntensityEnd(_) => "IntensityEnd",
            Self::LpgmRelease(_) => "LpgmRelease",
            Self::ReportRelease { .. } => "ReportRelease",
            Self::ReportSpeechEnd(_) => "ReportSpeechEnd",
            Self::ReportListUpdate => "ReportListUpdate",
            Self::ReplayStateChange { .. } => "ReplayStateChange",
            Self::RtsPga1 => "RtsPga1",
            Self::RtsPga2 => "RtsPga2",
            Self::RtsShindo0 => "RtsShindo0",
            Self::RtsShindo1 => "RtsShindo1",
            Self::RtsShindo2 => "RtsShindo2",
        }
    }
}
