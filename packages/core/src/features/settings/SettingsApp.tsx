import { useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import { arch, type as osType, version as osVersion } from "@tauri-apps/plugin-os";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { ChevronDown, Copy, Minus, X } from "lucide-react";

import { IntensityBadge } from "@/components/IntensityBadge";
import { region, regionReady } from "@/domain/region";
import { search_loc_name } from "@/domain/utils";
import { DEFAULT_API_PROXY_DOMAIN, INTENSITY_LIST } from "@/lib/constants";
import { loadConfig, resetConfig, writeConfig } from "@/lib/config";
import { inTauri } from "@/lib/env";
import type { Station, TremConfig } from "@/lib/types";

const TABS = [
  { id: "general", label: "一般" },
  { id: "graphics", label: "圖形" },
  { id: "sound", label: "音效" },
  { id: "extended", label: "擴充" },
  { id: "info", label: "關於" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const SOUND_EFFECTS = [
  ["sound-effects-dong", "咚咚咚音效（僅在有倒數情況下生效）", true],
  ["sound-effects-EEW", "EEW（收到地震預警時播放）"],
  ["sound-effects-EEW2", "EEW2（最大預估震度 5弱以上播放）"],
  ["sound-effects-PAlert", "INTENSITY（收到震度速報時播放）"],
  ["sound-effects-PGA1", "PGA1（PGA > 8gal 時播放）"],
  ["sound-effects-PGA2", "PGA2（PGA > 200gal 時播放）"],
  ["sound-effects-Report", "REPORT（收到地震報告時播放）"],
  ["sound-effects-Shindo0", "SHINDO0（地震檢知震度 0級以上播放）"],
  ["sound-effects-Shindo1", "SHINDO1（地震檢知震度 2級以上播放）"],
  ["sound-effects-Shindo2", "SHINDO2（地震檢知震度 4級以上播放）"],
  ["sound-effects-Update", "UPDATE（地震預警更正時播放）"],
] as const;

interface Choice {
  value: number;
  label: string;
}

export function SettingsApp() {
  const savedTab = localStorage.getItem("setting-tab") as TabId | null;
  const [tab, setTab] = useState<TabId>(TABS.some((item) => item.id === savedTab) ? savedTab! : "general");
  const [config, setConfig] = useState<TremConfig | null>(null);
  const [appVersion, setAppVersion] = useState("4.0.0");
  const [system, setSystem] = useState({ os: "Web", cpu: navigator.platform || "unknown" });
  const [stationData] = useState<Record<string, Station>>(loadCachedStations);
  const [regionRevision, setRegionRevision] = useState(0);
  const [proxy, setProxy] = useState(DEFAULT_API_PROXY_DOMAIN);
  const [updateStatus, setUpdateStatus] = useState("");

  useEffect(() => {
    void loadConfig(true).then(async (value) => {
      if (inTauri) {
        try {
          const actual = await isAutostartEnabled();
          const desired = !!value["check-box"]["other-auto-start"];
          if (desired !== actual) {
            if (desired) await enableAutostart();
            else await disableAutostart();
          }
        } catch {
          /* Keep the persisted preference if the OS does not expose login items. */
        }
      }
      setConfig(value);
      setProxy(value.apiProxyDomain || DEFAULT_API_PROXY_DOMAIN);
    });
    void regionReady.then(() => setRegionRevision((value) => value + 1));

    if (inTauri) {
      void getVersion().then(setAppVersion).catch(() => {});
      void Promise.resolve().then(() => {
        try {
          setSystem({ os: `${osType()} ${osVersion()}`, cpu: arch() });
        } catch {
          /* Tauri metadata can be unavailable briefly during dev reload. */
        }
      });
    }
  }, []);

  const locations = useMemo<Choice[]>(() => {
    void regionRevision;
    return Object.entries(region)
      .flatMap(([city, towns]) =>
        Object.entries(towns).map(([town, details]) => ({
          value: details.code,
          label: `${city}${town}`,
        })),
      )
      .sort((a, b) => a.value - b.value);
  }, [regionRevision]);

  const stations = useMemo<Choice[]>(
    () => {
      void regionRevision;
      return Object.entries(stationData)
        .flatMap(([id, station]) => {
          const latest = station.info.at(-1);
          if (!latest?.code) return [];
          const location = search_loc_name(latest.code);
          const net = station.net ? `${station.net} ` : "";
          return [{ value: Number(id), label: `${net}${location ? `${location.city}${location.town}` : latest.code}-${id}` }];
        })
        .sort((a, b) => a.label.localeCompare(b.label, "zh-Hant"));
    },
    [stationData, regionRevision],
  );

  if (!config) {
    return <div className="flex h-screen items-center justify-center bg-[#313131] text-white">載入中…</div>;
  }

  const save = (next: TremConfig, message = "設定已儲存") => {
    setConfig(next);
    setUpdateStatus(message);
    void writeConfig(next).catch((error) => setUpdateStatus(`儲存失敗：${String(error)}`));
  };

  const setCheck = (key: string, checked: boolean) => {
    save({ ...config, "check-box": { ...config["check-box"], [key]: checked } });
  };

  const selectTab = (next: TabId) => {
    setTab(next);
    localStorage.setItem("setting-tab", next);
    setUpdateStatus("");
  };

  const copyDebugInfo = async () => {
    const text = [
      "```",
      "- - - System Info - - -",
      `system: ${system.os}`,
      `cpu: ${system.cpu}`,
      "",
      "- - - TREM Info - - -",
      `version: ${appVersion}`,
      "```",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setUpdateStatus("複製成功！");
    } catch {
      setUpdateStatus("複製失敗！");
    }
  };

  const toggleAutostart = async (checked: boolean) => {
    if (!inTauri) {
      setCheck("other-auto-start", checked);
      return;
    }
    try {
      if (checked) await enableAutostart();
      else await disableAutostart();
      save({
        ...config,
        "check-box": { ...config["check-box"], "other-auto-start": checked },
      });
    } catch (error) {
      setUpdateStatus(`開機啟動設定失敗：${String(error)}`);
    }
  };

  const runUpdate = async () => {
    if (!inTauri) {
      setUpdateStatus("瀏覽器模式無法檢查桌面版更新");
      return;
    }
    setUpdateStatus("正在檢查更新…");
    try {
      const update = await check();
      if (!update) {
        setUpdateStatus(`目前已是最新版本（${appVersion}）`);
        return;
      }
      let downloaded = 0;
      let total = 0;
      setUpdateStatus(`發現新版本 ${update.version}，準備下載…`);
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          const progress = total ? ` ${Math.round((downloaded / total) * 100)}%` : "";
          setUpdateStatus(`下載更新中…${progress}`);
        }
        if (event.event === "Finished") setUpdateStatus("更新已安裝，3 秒後重新啟動…");
      });
      window.setTimeout(() => void relaunch(), 3000);
    } catch (error) {
      setUpdateStatus(`檢查更新失敗：${String(error)}`);
    }
  };

  return (
    <div className="legacy-settings-shell">
      <aside className="legacy-settings-sidebar" data-tauri-drag-region>
        <nav>
          {TABS.map((item) => (
            <button
              type="button"
              key={item.id}
              className={tab === item.id ? "is-active" : undefined}
              onClick={() => selectTab(item.id)}
            >
              {item.label}
            </button>
          ))}
          <button type="button" onClick={() => void copyDebugInfo()}>
            <Copy className="h-4 w-4" />
            複製 debug log
          </button>
        </nav>
      </aside>

      <main className="legacy-settings-content">
        <WindowControls />
        <h1>{TABS.find((item) => item.id === tab)?.label}</h1>
        <div className="legacy-settings-scroll">
          {tab === "general" && (
            <>
              <SettingSection title="所在地" description="設定所在地可以在地震發生時預估你所在區域的地震震度。">
                <SelectRow
                  value={config["location-code"]}
                  options={locations}
                  placeholder="未設定"
                  onChange={(value) => save({ ...config, "location-code": value })}
                />
              </SettingSection>

              <SettingSection title="即時測站" description="顯示於主畫面左上方的即時測站。">
                <SelectRow
                  value={config["realtime-station-id"]}
                  options={stations}
                  placeholder="未設定"
                  onChange={(value) => save({ ...config, "realtime-station-id": value })}
                />
              </SettingSection>

              <SettingSection
                title="預警條件"
                description="即時測站（任一站）為觸發時任一站震度門檻，預估震度（所在地）為地震預警時所在地震度門檻，達到任一條件後軟體將會發出音效及彈出視窗。"
              >
                <IntensitySelectRow
                  label="即時測站（任一站）"
                  value={config["alert-level"]["rts-intensity"]}
                  onChange={(value) =>
                    save({
                      ...config,
                      "alert-level": { ...config["alert-level"], "rts-intensity": value },
                    })
                  }
                />
                <IntensitySelectRow
                  label="預估震度（所在地）"
                  value={config["alert-level"]["eew-intensity"]}
                  onChange={(value) =>
                    save({
                      ...config,
                      "alert-level": { ...config["alert-level"], "eew-intensity": value },
                    })
                  }
                />
              </SettingSection>

              <SettingSection title="顯示視窗" description="程式自動跳窗時機。">
                <ToggleRow label="地震預警" checked={!!config["check-box"]["show-window-eew"]} onChange={(value) => setCheck("show-window-eew", value)} />
                <ToggleRow label="地震報告" checked={!!config["check-box"]["show-window-report"]} onChange={(value) => setCheck("show-window-report", value)} />
                <ToggleRow label="地震檢知" checked={!!config["check-box"]["show-window-detect"]} onChange={(value) => setCheck("show-window-detect", value)} />
                <ToggleRow label="震度速報" checked={!!config["check-box"]["show-window-rts-intensity"]} onChange={(value) => setCheck("show-window-rts-intensity", value)} />
              </SettingSection>

              <SettingSection title="其他功能" description="TREM Lite 不常用的小功能都在這裡。">
                <ToggleRow label="開機自動啟動" checked={!!config["check-box"]["other-auto-start"]} onChange={(value) => void toggleAutostart(value)} />
              </SettingSection>

              <SettingSection title="API 代理網域" description="設定備援 API 代理網域；清空時自動使用預設網域。">
                <div className="legacy-setting-row legacy-proxy-row">
                  <input value={proxy} spellCheck={false} onChange={(event) => setProxy(event.target.value)} onBlur={() => {
                    const value = proxy.trim() || DEFAULT_API_PROXY_DOMAIN;
                    setProxy(value);
                    save({ ...config, apiProxyDomain: value });
                  }} onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }} />
                  <button type="button" onClick={() => {
                    setProxy(DEFAULT_API_PROXY_DOMAIN);
                    save({ ...config, apiProxyDomain: DEFAULT_API_PROXY_DOMAIN });
                  }}>重置</button>
                </div>
              </SettingSection>

              <SettingSection title="檢查更新" description="檢查是否有新版本可用，並自動下載安裝。">
                <ToggleRow label="啟用 OTA（自動更新）" checked={!!config["check-box"]["ota-auto-update"]} onChange={(value) => setCheck("ota-auto-update", value)} />
                <ActionRow label="檢查軟體更新" action="檢查更新" onClick={() => void runUpdate()} />
              </SettingSection>

              <SettingSection title="重設">
                <ActionRow label="重置所有設定" action="重設" danger onClick={() => void resetConfig().then((value) => {
                  setConfig(value);
                  setProxy(value.apiProxyDomain);
                  setUpdateStatus("已重設所有設定");
                })} />
              </SettingSection>
            </>
          )}

          {tab === "graphics" && (
            <SettingSection title="地圖自動縮放" description="預設地圖自動縮放為啟用狀態。">
              <ToggleRow label="禁用地圖自動縮放" checked={!!config["check-box"]["graphics-block-auto-zoom"]} onChange={(value) => setCheck("graphics-block-auto-zoom", value)} />
            </SettingSection>
          )}

          {tab === "sound" && (
            <>
              <SettingSection title="預警播報" description="地震發生時播報所在地預估震度以及地震波抵達剩餘秒數。">
                <ToggleRow label={SOUND_EFFECTS[0][1]} checked={!!config["check-box"][SOUND_EFFECTS[0][0]]} disabled />
              </SettingSection>
              <SettingSection title="音效列表" description="開啟或關閉特定的音效。">
                {SOUND_EFFECTS.slice(1).map(([key, label]) => (
                  <ToggleRow key={key} label={label} checked={!!config["check-box"][key]} onChange={(value) => setCheck(key, value)} />
                ))}
              </SettingSection>
            </>
          )}

          {tab === "extended" && (
            <ExtendedSettings />
          )}

          {tab === "info" && (
            <>
              <SettingSection title="關於 TREM Lite" description="TREM-Lite 是一款開源地震速報軟體，提供給您即時的地震資訊，利用自製的測站，顯示各地的即時震度，在地震發生的第一時間取得各管道發布的強震即時警報資訊。">
                <InfoRow label="程式版本" value={appVersion} />
                <InfoRow label="系統版本" value={system.os} />
                <InfoRow label="CPU" value={system.cpu} />
              </SettingSection>
              <SettingSection title="資料來源">
                <InfoRow label="地震預警" value="交通部中央氣象署（CWA）" />
                <InfoRow label="震度" value="中央研究院（SINICA）、臺灣即時地震監測（TREM）" />
              </SettingSection>
              <SettingSection title="貢獻者" description="感謝所有參與 TREM Lite 開發與維護的貢獻者。">
                <a className="legacy-contributor" href="https://github.com/ExpTechTW/TREM-Lite/graphs/contributors" target="_blank" rel="noreferrer">
                  <img src="https://contrib.rocks/image?repo=ExpTechTW/TREM-Lite" alt="TREM Lite 貢獻者" />
                </a>
              </SettingSection>
            </>
          )}
        </div>

        {updateStatus && <div className="legacy-settings-toast">{updateStatus}</div>}
      </main>
    </div>
  );
}

function WindowControls() {
  return (
    <div className="legacy-settings-window-controls">
      <button type="button" onClick={() => void getCurrentWindow().minimize()}><Minus /></button>
      <button type="button" onClick={() => void getCurrentWindow().close()}><X /></button>
    </div>
  );
}

function ExtendedSettings() {
  const [view, setView] = useState<"status" | "installed">("status");
  return (
    <section className="legacy-setting-section legacy-extended-section">
      <div className="legacy-setting-heading">
        <h2>擴充功能</h2>
        <p>
          使用來源不明或無法信任的擴充可能危及您的個人資訊安全，請謹慎使用。・
          <a href="https://exptechtw.github.io/trem-plugins/" target="_blank" rel="noreferrer">TREM 擴充商店</a>
        </p>
      </div>
      <div className="legacy-extended-tabs">
        <button type="button" className={view === "status" ? "is-active" : undefined} onClick={() => setView("status")}>擴充狀態</button>
        <button type="button" className={view === "installed" ? "is-active" : undefined} onClick={() => setView("installed")}>擴充列表</button>
      </div>
      <div className="legacy-setting-card legacy-extended-card">
        <div className="legacy-extended-empty">
          {view === "status" ? "未有異常擴充" : "未安裝擴充"}
        </div>
      </div>
      <p className="legacy-extended-sandbox-note">Tauri 版僅顯示沙箱相容擴充；舊 Electron Node 外掛不會直接載入。</p>
    </section>
  );
}

function SettingSection({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="legacy-setting-section">
      <div className="legacy-setting-heading">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      <div className="legacy-setting-card">{children}</div>
    </section>
  );
}

function SelectRow({ value, options, placeholder, onChange }: { value: number; options: Choice[]; placeholder: string; onChange: (value: number) => void }) {
  const current = options.find((option) => option.value === Number(value));
  return (
    <label className="legacy-setting-row legacy-select-row">
      <span>{current?.label ?? placeholder}</span>
      <ChevronDown />
      <select value={value || ""} onChange={(event) => onChange(Number(event.target.value))}>
        <option value="" disabled>{placeholder}</option>
        {options.map((option) => <option key={`${option.value}-${option.label}`} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function IntensitySelectRow({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="legacy-setting-row legacy-select-row">
      <span className="flex items-center gap-3">
        {label}
        <IntensityBadge i={value} className="h-6 w-9 rounded-[5px] border border-white/20 text-sm" />
      </span>
      <ChevronDown />
      <select value={value} onChange={(event) => onChange(Number(event.target.value))}>
        {INTENSITY_LIST.map((text, index) => <option key={index} value={index}>{text}</option>)}
      </select>
    </label>
  );
}

function ToggleRow({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange?: (value: boolean) => void; disabled?: boolean }) {
  return (
    <div className="legacy-setting-row">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className="legacy-toggle"
        onClick={() => onChange?.(!checked)}
      >
        <span />
      </button>
    </div>
  );
}

function ActionRow({ label, action, onClick, danger = false }: { label: string; action: string; onClick: () => void; danger?: boolean }) {
  return (
    <div className="legacy-setting-row">
      <span>{label}</span>
      <button type="button" className={danger ? "legacy-action is-danger" : "legacy-action"} onClick={onClick}>{action}</button>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return <div className="legacy-setting-row"><span>{label}</span><span className="legacy-info-value">{value}</span></div>;
}

function loadCachedStations(): Record<string, Station> {
  try {
    const cached = localStorage.getItem("cache.station");
    return cached ? (JSON.parse(cached) as Record<string, Station>) : {};
  } catch {
    return {};
  }
}
