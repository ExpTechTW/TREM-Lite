const TREM = {
  constant: {
    COLOR: {
      MAP: {
        BACKGROUND: '#1f2025',
        TW_COUNTY_FILL: '#3F4045',
        TW_TOWN_FILL: '#3F4045',
        TW_COUNTY_OUTLINE: '#a9b4bc',
        GLOBAL_FILL: '#3F4045',
      },
      RTS: {
        intensity_3: '#0005d0',
        intensity_2: '#004bf8',
        intensity_1: '#009EF8',
        intensity0: '#79E5FD',
        intensity1: '#49E9AD',
        intensity2: '#44fa34',
        intensity3: '#beff0c',
        intensity4: '#fff000',
        intensity5: '#ff9300',
        intensity6: '#fc5235',
        intensity7: '#b720e9',
      },
      INTENSITY: {
        0: '#202020',
        1: '#003264',
        2: '#0064c8',
        3: '#1e9632',
        4: '#ffc800',
        5: '#ff9600',
        6: '#ff6400',
        7: '#ff0000',
        8: '#c00000',
        9: '#9600c8',
      },
      INTENSITY_TEXT: {
        0: '#ffffff',
        1: '#ffffff',
        2: '#ffffff',
        3: '#ffffff',
        4: '#000000',
        5: '#000000',
        6: '#000000',
        7: '#ffffff',
        8: '#ffffff',
        9: '#ffffff',
      },
      LPGM: {
        1: '#0040ff',
        2: '#ffe600',
        3: '#ff2800',
        4: '#a50021',
      },
      LPGM_TEXT: {
        1: '#ffffff',
        2: '#000000',
        3: '#ffffff',
        4: '#ffffff',
      },
      EEW: {
        S: {
          WARN: '#ffaa00',
          ALERT: '#ff0000',
          CANCEL: '#404040',
        },
        TRIGGER: {
          LOW: '#1e9632',
          MIDDLE: '#ffc800',
          HIGH: '#c00000',
        },
        P: '#00CACA',
      },
      TREM: {
        S: '#beff0c',
        P: '#beff0c',
      },
      BOX: {
        0: '#00DB00',
        1: '#EAC100',
        2: '#FF0000',
      },
    },

    SHOW_TREM_EEW: false,

    URL: {
      API: ['api-1.exptech.dev', 'api-2.exptech.dev'],
      LB: [
        'lb-1.exptech.dev',
        'lb-2.exptech.dev',
        'lb-3.exptech.dev',
        'lb-4.exptech.dev',
      ],
      REPLAY: ['api-2.exptech.dev'],
    },

    AUDIO: {
      ALERT: new Audio('../audio/ALERT.wav'),
      EEW: new Audio('../audio/EEW.wav'),
      INTENSITY: new Audio('../audio/INTENSITY.wav'),
      PGA1: new Audio('../audio/PGA1.wav'),
      PGA2: new Audio('../audio/PGA2.wav'),
      REPORT: new Audio('../audio/REPORT.wav'),
      SHINDO0: new Audio('../audio/SHINDO0.wav'),
      SHINDO1: new Audio('../audio/SHINDO1.wav'),
      SHINDO2: new Audio('../audio/SHINDO2.wav'),
      TSUNAMI: new Audio('../audio/TSUNAMI.wav'),
      UPDATE: new Audio('../audio/UPDATE.wav'),
    },

    HTTP_TIMEOUT: {
      RESOURCE: 3500,
      RTS: 1500,
      EEW: 1500,
      REPORT: 5000,
      INTENSITY: 1500,
      LPGM: 1500,
      NTP: 1500,
    },

    LAST_DATA_TIMEOUT_ERROR: 3000,

    EEW_AUTHOR: ['trem', 'cwa'],

    REPORT_LIMIT: 75,

    MAP: {
      BOUNDS: [[118.0, 21.2], [124.0, 25.8]],
      OPTIONS: { padding: 20, duration: 0 },
    },

    SHOW_REPORT: true,

    GAME_MODE: true,

    WINDOW_FOCUS_EVENTS: [
      'EewRelease',
      'EewAlert',
      'RtsPga2',
      'RtsPga1',
      'RtsShindo2',
      'RtsShindo1',
      'RtsShindo0',
      'ReportRelease',
      'IntensityRelease',
      'LpgmRelease',
      'TsunamiRelease',
      'EewNewAreaAlert',
    ],

    SHOW_PIP_EVENTS: [
      'EewRelease',
      'EewAlert',
      'RtsShindo2',
      'RtsShindo1',
      'RtsShindo0',
      'TsunamiRelease',
      'EewNewAreaAlert',
    ],
  },

  variable: {
    rts_station_id: 6110036,
    map: null,
    events: null,
    time: null,
    data: {
      rts: null,
      intensity: [],
      report: [],
      eew: [],
      lpgm: [],
    },
    // 0 realtime (http) | 1 realtime (websocket) | 2 replay (http) | 3 replay (file)
    play_mode: 0,
    replay: {
      start_time: 0,
      local_time: 0,
    },
    station: null,
    speech: null,
    tts: true,

    // 不要動下方的東西
    cache: {
      rts_alert: false,
      unstable: 0,
      show_eew_box: false,
      rts_trigger: {
        max: 0,
        loc: [],
      },
      int_cache_list: {},
      last_report: null,
      eewIntensityArea: {},
      show_intensity: false,
      show_lpgm: false,
      eew_last: {},
      intensity_last: {},
      time: {
        syncedTime: 0,
        lastSync: 0,
      },
      intensity: {
        time: 0,
        max: 0,
      },
      last_data_time: 0,
      last_rts_alert: 0,
      bounds: {
        rts: [],
        intensity: [],
        report: [],
        lpgm: [],
      },
      audio: {
        shindo: -1,
        pga: -1,
        status: {
          shindo: 0,
          pga: 0,
        },
        count: {
          pga_1: 0,
          pga_2: 0,
          shindo_1: 0,
          shindo_2: 0,
        },
      },
    },
  },
  class: {
    EewManager: null,
    ReportManager: null,
    FocusManager: null,
    EewAreaManager: null,
    BoxManager: null,
    AudioManager: null,
    ReplayControler: null,
    WindowControler: null,
  },
};

TREM.constant.AUDIO.SHINDO0.volume = 0.4;
TREM.constant.AUDIO.UPDATE.volume = 0.2;

if (TREM.constant.SHOW_TREM_EEW) {
  TREM.constant.EEW_AUTHOR = TREM.constant.EEW_AUTHOR.filter((author) => author != 'cwa');
}

module.exports = TREM;
