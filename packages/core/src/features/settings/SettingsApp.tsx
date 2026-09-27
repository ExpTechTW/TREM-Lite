import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { getVersion } from "@tauri-apps/api/app";
import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { disable as disableAutostart, enable as enableAutostart } from "@tauri-apps/plugin-autostart";
import { arch, type as osType, version as osVersion } from "@tauri-apps/plugin-os";
import { BellRing, Copy, Info, Minus, SlidersHorizontal, Volume2, X } from "lucide-react";

import { regionReady } from "@/domain/region";
import { search_loc_name } from "@/domain/utils";
import { STATION_CACHE_KEY } from "@/features/data/resource";
import { loadConfig, onConfigUpdated, resetConfig, writeConfig } from "@/lib/config";
import { inTauri } from "@/lib/env";
import type { Station, TremConfig } from "@/lib/types";
import { versionLabel } from "@/lib/version";

/**
 * The settings window. Four pages, each only what is used:
 *
 *   一般  the station shown on the map, starting with the system, the map's
 *         automatic zoom
 *   警報  which events bring the window forward, speech announcements
 *   音效  each sound effect, on or off
 *   關於  version and updates, data sources, links, and the reset
 *
 * Every change is saved at once (config.rs broadcasts it to the main window).
 * The page also follows changes made elsewhere — the main window moves the
 * station when its list changes — so it never writes back an old copy.
 *
 * The web has no second window: the same page opens over the map
 * (`SettingsModal`), without what only the desktop does — bringing a window
 * forward, starting with the system, updating itself.
 */
const TABS = [
  { id: "general", label: "一般", icon: SlidersHorizontal },
  { id: "alerts", label: "警報", icon: BellRing },
  { id: "sound", label: "音效", icon: Volume2 },
  { id: "about", label: "關於", icon: Info },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** The sound effects by group: [config key, name, when it plays]. */
const SOUNDS: [string, [string, string, string][]][] = [
  [
    "地震預警",
    [
      ["sound-effects-EEW", "地震預警", "收到地震預警時"],
      ["sound-effects-EEW2", "緊急地震速報", "預警升級為警報時"],
      ["sound-effects-Update", "預警更新", "預警內容更新時"],
    ],
  ],
  [
    "地震檢知",
    [
      ["sound-effects-Shindo0", "檢知・弱", "測站偵測到搖晃"],
      ["sound-effects-Shindo1", "檢知・中", "測站震度 2 以上"],
      ["sound-effects-Shindo2", "檢知・強", "測站震度 4 以上"],
      ["sound-effects-PGA1", "加速度・中", "測站加速度超過 8 gal"],
      ["sound-effects-PGA2", "加速度・強", "測站加速度超過 200 gal"],
    ],
  ],
  [
    "報告",
    [
      ["sound-effects-PAlert", "震度速報", "收到震度速報或長週期地震動時"],
      ["sound-effects-Report", "地震報告", "收到地震報告時"],
    ],
  ],
];

const WINDOW_EVENTS: [string, string][] = [
  ["show-window-eew", "地震預警"],
  ["show-window-detect", "地震檢知"],
  ["show-window-rts-intensity", "震度速報"],
  ["show-window-report", "地震報告"],
];

const REPO = "https://github.com/ExpTechTW/TREM-Lite";

interface Choice {
  value: string;
  label: string;
}

function loadCachedStations(): Record<string, Station> {
  try {
    const cached = localStorage.getItem(STATION_CACHE_KEY);
    return cached ? (JSON.parse(cached) as Record<string, Station>) : {};
  } catch {
    return {};
  }
}

export function SettingsApp({ onClose }: { onClose?: () => void }) {
  const savedTab = localStorage.getItem("setting-tab");
  const [tab, setTab] = useState<TabId>(TABS.find((t) => t.id === savedTab)?.id ?? "general");
  const [config, setConfig] = useState<TremConfig | null>(null);
  const [version, setVersion] = useState("");
  const [system] = useState(() => {
    if (!inTauri) return "";
    try {
      return `${osType()} ${osVersion()} (${arch()})`;
    } catch {
      return ""; // unavailable for a moment during a dev reload
    }
  });
  const [status, setStatus] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [regionLoaded, setRegionLoaded] = useState(false);
  const [stationData] = useState(loadCachedStations);

  useEffect(() => {
    void loadConfig(true).then(setConfig);
    const unlisten = onConfigUpdated(setConfig);
    void regionReady.then(() => setRegionLoaded(true));
    if (inTauri) {
      void getVersion()
        .then((v) => setVersion(versionLabel(v)))
        .catch(() => {});
    }
    return () => void unlisten.then((un) => un());
  }, []);

  // A message fades after a few seconds.
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), 3500);
    return () => clearTimeout(timer);
  }, [status]);

  const stations = useMemo<Choice[]>(() => {
    void regionLoaded;
    return Object.entries(stationData)
      .flatMap(([id, station]) => {
        const code = station.info.at(-1)?.code;
        const place = code ? search_loc_name(code) : null;
        return place ? [{ value: id, label: `${place.city}${place.town}（${id}）` }] : [];
      })
      .sort((a, b) => a.label.localeCompare(b.label, "zh-Hant"));
  }, [stationData, regionLoaded]);

  if (!config) {
    return <div className="settings-loading">載入中…</div>;
  }

  const save = (next: TremConfig) => {
    setConfig(next);
    void writeConfig(next).catch((error) => setStatus(`儲存失敗：${String(error)}`));
  };
  const check = (key: string) => !!config["check-box"][key];
  const setCheck = (key: string, value: boolean) =>
    save({ ...config, "check-box": { ...config["check-box"], [key]: value } });

  const selectTab = (next: TabId) => {
    setTab(next);
    setConfirmReset(false);
    localStorage.setItem("setting-tab", next);
  };

  const toggleAutostart = async (on: boolean) => {
    try {
      if (inTauri) await (on ? enableAutostart() : disableAutostart());
      setCheck("other-auto-start", on);
    } catch (error) {
      setStatus(`開機啟動設定失敗：${String(error)}`);
    }
  };

  const checkUpdate = async () => {
    setStatus("正在檢查更新…");
    try {
      const progress = new Channel<{ downloaded: number; total: number | null }>();
      progress.onmessage = ({ downloaded, total }) =>
        setStatus(`下載更新中…${total ? ` ${Math.round((downloaded / total) * 100)}%` : ""}`);
      const result = await invoke<{ status: "upToDate"; current: string } | { status: "staged"; version: string }>(
        "update_check",
        { onProgress: progress },
      );
      setStatus(
        result.status === "staged"
          ? `已下載 ${versionLabel(result.version)}，下次啟動時更新`
          : `已是最新版本（${versionLabel(result.current)}）`,
      );
    } catch (error) {
      setStatus(`檢查更新失敗：${String(error)}`);
    }
  };

  const copyInfo = async () => {
    const text = `TREM Lite ${version || "(web)"}\n${system || navigator.userAgent}`;
    try {
      await navigator.clipboard.writeText(text);
      setStatus("已複製版本資訊");
    } catch {
      setStatus("複製失敗");
    }
  };

  const reset = async () => {
    setConfirmReset(false);
    setConfig(await resetConfig());
    setStatus("已還原預設設定");
  };

  const station = String(config["realtime-station-id"]);

  return (
    <div className={onClose ? "settings-shell is-embedded" : "settings-shell"}>
      <aside className="settings-sidebar" data-tauri-drag-region>
        <div className="settings-brand" data-tauri-drag-region>
          TREM Lite
        </div>
        <nav>
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={tab === id ? "is-active" : undefined}
              onClick={() => selectTab(id)}
            >
              <Icon aria-hidden />
              {label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="settings-main">
        <header className="settings-header" data-tauri-drag-region>
          <h1 data-tauri-drag-region>{TABS.find((t) => t.id === tab)?.label}</h1>
          {onClose ? (
            <div className="settings-window-controls">
              <button type="button" aria-label="關閉" onClick={onClose}>
                <X />
              </button>
            </div>
          ) : (
            inTauri && (
              <div className="settings-window-controls">
                <button type="button" aria-label="最小化" onClick={() => void getCurrentWindow().minimize()}>
                  <Minus />
                </button>
                <button type="button" aria-label="關閉" onClick={() => void getCurrentWindow().close()}>
                  <X />
                </button>
              </div>
            )
          )}
        </header>

        <div className="settings-scroll">
          {tab === "general" && (
            <>
              <Group title="我的測站" note="主畫面左上角顯示這個測站的即時震度與加速度。">
                <Row label="測站">
                  <select
                    value={stations.some((s) => s.value === station) ? station : ""}
                    onChange={(event) => save({ ...config, "realtime-station-id": event.target.value })}
                  >
                    <option value="" disabled>
                      {stations.length ? "請選擇" : "測站清單載入中，請稍後再開啟設定"}
                    </option>
                    {stations.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </Row>
              </Group>
              <Group title="地圖">
                <Toggle
                  label="自動縮放到事件"
                  hint="有地震預警、檢知或報告時，地圖自動移到相關區域"
                  checked={!check("graphics-block-auto-zoom")}
                  onChange={(on) => setCheck("graphics-block-auto-zoom", !on)}
                />
              </Group>
              {inTauri && (
                <Group title="系統">
                  <Toggle
                    label="開機時自動啟動"
                    hint="登入後在背景啟動，縮在系統匣"
                    checked={check("other-auto-start")}
                    onChange={(on) => void toggleAutostart(on)}
                  />
                </Group>
              )}
            </>
          )}

          {tab === "alerts" && (
            <>
              {inTauri && (
                <Group title="跳出主視窗" note="主視窗縮小或隱藏時，發生以下事件會把它叫回前景。">
                  {WINDOW_EVENTS.map(([key, label]) => (
                    <Toggle key={key} label={label} checked={check(key)} onChange={(on) => setCheck(key, on)} />
                  ))}
                </Group>
              )}
              <Group title="語音">
                <Toggle
                  label="語音播報"
                  hint="朗讀地震預警、震度速報與地震報告的內容"
                  checked={check("other-tts")}
                  onChange={(on) => setCheck("other-tts", on)}
                />
              </Group>
            </>
          )}

          {tab === "sound" &&
            SOUNDS.map(([group, sounds], i) => (
              <Group
                key={group}
                title={group}
                note={i === SOUNDS.length - 1 ? "預警取消與海嘯警報的音效一律播放。" : undefined}
              >
                {sounds.map(([key, label, hint]) => (
                  <Toggle key={key} label={label} hint={hint} checked={check(key)} onChange={(on) => setCheck(key, on)} />
                ))}
              </Group>
            ))}

          {tab === "about" && (
            <>
              <Group title="版本" note={inTauri ? "新版本會在背景自動下載。" : undefined}>
                <Row label="TREM Lite">
                  <div className="settings-actions">
                    <span className="settings-value">{version || "網頁版"}</span>
                    {inTauri && (
                      <button type="button" onClick={() => void checkUpdate()}>
                        檢查更新
                      </button>
                    )}
                  </div>
                </Row>
                {inTauri && (
                  <Toggle
                    label="自動重新啟動以完成更新"
                    hint="新版本下載後，在沒有地震事件時自動重新啟動並套用；關閉則等下次開啟時套用"
                    checked={check("update-auto-restart")}
                    onChange={(on) => setCheck("update-auto-restart", on)}
                  />
                )}
                {system && (
                  <Row label="系統">
                    <span className="settings-value">{system}</span>
                  </Row>
                )}
                <Row label="回報問題時附上版本與系統">
                  <button type="button" onClick={() => void copyInfo()}>
                    <Copy aria-hidden />
                    複製
                  </button>
                </Row>
              </Group>
              <Group title="資料來源">
                <Row label="地震預警、地震報告">
                  <span className="settings-value">交通部中央氣象署</span>
                </Row>
                <Row label="即時測站、震度速報">
                  <span className="settings-value">ExpTech Studio（TREM 測站網）</span>
                </Row>
              </Group>
              <Group title="連結">
                <Row label="原始碼與問題回報">
                  <a href={REPO} target="_blank" rel="noreferrer">
                    GitHub
                  </a>
                </Row>
                <Row label="貢獻者">
                  <a href={`${REPO}/graphs/contributors`} target="_blank" rel="noreferrer">
                    查看
                  </a>
                </Row>
              </Group>
              <Group title="還原">
                <Row label="將所有設定還原為預設值">
                  {confirmReset ? (
                    <div className="settings-actions">
                      <button type="button" onClick={() => setConfirmReset(false)}>
                        取消
                      </button>
                      <button type="button" className="is-danger" onClick={() => void reset()}>
                        確定還原
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="is-danger" onClick={() => setConfirmReset(true)}>
                      還原預設
                    </button>
                  )}
                </Row>
              </Group>
            </>
          )}
        </div>

        {status && (
          <div className="settings-toast" role="status">
            {status}
          </div>
        )}
      </main>
    </div>
  );
}

/**
 * The settings page over the map, for the web. Esc or a click outside closes
 * it. Portalled to <body>: under the nav bar it would stay within the bar's
 * stacking context, below the map's other overlays.
 */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div
      className="settings-modal"
      role="dialog"
      aria-modal="true"
      aria-label="設定"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <SettingsApp onClose={onClose} />
    </div>,
    document.body,
  );
}

function Group({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="settings-group">
      <h2>{title}</h2>
      <div className="settings-card">{children}</div>
      {note && <p className="settings-note">{note}</p>}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <span className="settings-label">{label}</span>
      {children}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-row settings-toggle-row">
      <span className="settings-label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="settings-switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
