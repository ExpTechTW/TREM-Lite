/**
 * 擴充 — the extensions page.
 *
 * V3's `setting/plugin_list.js` page, rebuilt: the same rows (verified or not,
 * loaded or not, what it can touch, what went wrong), the same 10-second
 * countdown before an unverified extension may be enabled, the same one-click
 * removal. What is new is installing: a `.trem` package can be dropped onto the
 * page, which is the whole install flow — the archive is unpacked in the
 * webview and written through the host.
 *
 * The markup mirrors `SettingsApp`'s `Group`/`Row` so the page looks like the
 * other four; the two components are private to that file, and copying three
 * lines of JSX beats exporting them across an import cycle.
 */
import { ChevronRight, FolderOpen, Puzzle, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { authorNames, localizedText, pluginLoader, pluginStorageAvailable } from "../plugin";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { createLogger } from "@/lib/logger";

import type { PluginEntry } from "../plugin";

const log = createLogger("plugin");

/** V3 made an author wait before enabling something unsigned. */
const UNVERIFIED_WAIT = 10;

export function ExtensionsTab() {
  const loader = pluginLoader();
  const [entries, setEntries] = useState<PluginEntry[]>(() => loader?.list() ?? []);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<{ name: string; left: number } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // Which rows are unfolded. The details belong to the extension they describe,
  // so they live inside its row instead of in a second list further down, where
  // two extensions' facts were only told apart by the name on the left.
  const [open, setOpen] = useState<string[]>([]);

  useEffect(() => {
    if (!loader) return;
    const update = () => setEntries(loader.list());
    update();
    return loader.subscribe(update);
  }, [loader]);

  // V3's pause before an unsigned extension may be enabled: the button counts
  // down, and only a second click — after it reached zero — installs trust.
  const waitingFor = countdown?.name;
  useEffect(() => {
    if (!waitingFor) return;
    const timer = window.setInterval(() => {
      setCountdown((current) => (current && current.left > 0 ? { ...current, left: current.left - 1 } : current));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [waitingFor]);

  // A browser tab has no plugin folder: there is nowhere to install into and
  // nothing to run. A missing loader on the desktop is only the moment before
  // the list arrives — 設定 → 擴充 is a second webview and does read storage.
  if (!pluginStorageAvailable || !loader) {
    return (
      <Section
        title="擴充功能"
        note={pluginStorageAvailable ? "擴充功能清單尚未讀取完成。" : "擴充功能只能在桌面版執行。"}
      >
        <Line label="目前環境">
          <span className="settings-value">{pluginStorageAvailable ? "讀取中" : "不支援"}</span>
        </Line>
      </Section>
    );
  }

  const run = async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    setNote(null);
    try {
      await action();
    } catch (e) {
      log.error(`擴充功能操作失敗：${String(e)}`);
      setNote(String(e));
    } finally {
      setBusy(null);
    }
  };

  const install = async (file: File) => {
    setBusy("<install>");
    setNote(null);
    try {
      const name = await loader.installPackage(new Uint8Array(await file.arrayBuffer()));
      setNote(`已安裝 ${name}，啟用後將於下次啟動載入。`);
    } catch (e) {
      setNote(`安裝失敗：${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Section
        title="已安裝的擴充功能"
        note="擴充功能由社群提供，安裝前請確認來源。未簽章的擴充功能無法驗證作者身分。載入結果是上一次啟動的紀錄，改了設定要重新啟動才會生效。"
      >
        {entries.length === 0 ? (
          <Line label="沒有安裝任何擴充功能">
            <button type="button" onClick={() => void revealItemInDir(loader.rootPath)}>
              <FolderOpen /> 開啟資料夾
            </button>
          </Line>
        ) : (
          entries.map((entry) => {
            const expanded = open.includes(entry.name);
            return (
              <div className="settings-extension" key={entry.name}>
                <div className="settings-row">
                  <button
                    type="button"
                    className="settings-extension-head"
                    aria-expanded={expanded}
                    aria-controls={`extension-detail-${entry.name}`}
                    onClick={() =>
                      setOpen((current) =>
                        expanded ? current.filter((name) => name !== entry.name) : [...current, entry.name],
                      )
                    }
                  >
                    <ChevronRight />
                    {entry.info.name}
                    {entry.info.version && <span className="settings-extension-version">{entry.info.version}</span>}
                  </button>
                  <div className="settings-actions">
                    {entry.loaded && <span className="settings-badge is-ok">已載入</span>}
                    {/* Enabled but not running: the dependency or the signature
                        said no, and the reason is one unfold away. */}
                    {entry.enabled && !entry.loaded && <span className="settings-badge is-warn">未載入</span>}
                    <span className={`settings-badge ${entry.verified ? "is-ok" : "is-warn"}`}>
                      {entry.verified ? "已驗證" : "未驗證"}
                    </span>
                    <button
                      type="button"
                      disabled={busy === entry.name}
                      onClick={() => {
                        if (entry.enabled) {
                          void run(entry.name, () => loader.setEnabled(entry.name, false));
                          return;
                        }
                        // An unsigned plugin is a decision, not a click: V3 asked
                        // for ten seconds of it, and that is worth keeping.
                        if (!entry.verified && countdown?.name !== entry.name) {
                          setCountdown({ name: entry.name, left: UNVERIFIED_WAIT });
                          return;
                        }
                        void run(entry.name, () => loader.setEnabled(entry.name, true));
                      }}
                    >
                      {entry.enabled
                        ? "停用"
                        : countdown?.name === entry.name
                          ? countdown.left > 0
                            ? `請等待 ${countdown.left} 秒`
                            : "確認啟用"
                          : entry.verified
                            ? "啟用"
                            : "仍要啟用"}
                    </button>
                    {confirmRemove === entry.name ? (
                      <>
                        <button type="button" onClick={() => setConfirmRemove(null)}>
                          取消
                        </button>
                        <button
                          type="button"
                          className="is-danger"
                          onClick={() => {
                            setConfirmRemove(null);
                            void run(entry.name, () => loader.remove(entry.name));
                          }}
                        >
                          確定刪除
                        </button>
                      </>
                    ) : (
                      <button type="button" className="is-danger" onClick={() => setConfirmRemove(entry.name)}>
                        <Trash2 /> 刪除
                      </button>
                    )}
                  </div>
                </div>

                {expanded && (
                  <div className="settings-extension-body" id={`extension-detail-${entry.name}`}>
                    {/* Why it is not running comes first: it is the only line
                        here that asks the reader to do something. */}
                    {entry.status && entry.status.type !== "ok" && (
                      <p className={entry.status.type === "error" ? "settings-error" : "settings-note"}>
                        {entry.status.msg}
                      </p>
                    )}
                    {entry.verifyError && entry.verifyError !== entry.status?.msg && (
                      <p className="settings-note">簽章：{entry.verifyError}</p>
                    )}
                    <p className="settings-extension-description">
                      {localizedText(entry.info.description) ?? "沒有說明。"}
                    </p>
                    <p className="settings-note">作者：{authorNames(entry.info.author).join("、") || "未提供"}</p>
                    <p className="settings-note">
                      敏感度：{entry.sensitivity.description}
                      {entry.keyId ? `（簽章金鑰：${entry.keyId}）` : ""}
                    </p>
                    {entry.info.dependencies && Object.keys(entry.info.dependencies).length > 0 && (
                      <p className="settings-note">
                        相依：
                        {Object.entries(entry.info.dependencies)
                          .map(([dependency, range]) => `${dependency} ${range}`)
                          .join("、")}
                      </p>
                    )}
                    {entry.hasConfig && <p className="settings-note">這個擴充功能有 config.yml。</p>}
                  </div>
                )}
              </div>
            );
          })
        )}
      </Section>

      <Section title="安裝">
        <Line label="將 .trem 檔案拖曳到這裡">
          <div
            className={dragging ? "settings-drop is-active" : "settings-drop"}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files[0];
              if (file) void install(file);
            }}
          >
            <Puzzle />
            {busy === "<install>" ? "安裝中…" : dragging ? "放開以安裝" : "拖曳 .trem 套件"}
          </div>
        </Line>
        <Line label="擴充功能資料夾">
          <button type="button" disabled={!loader.rootPath} onClick={() => void revealItemInDir(loader.rootPath)}>
            <FolderOpen /> 開啟
          </button>
        </Line>
      </Section>

      {note && (
        <p className="settings-note settings-extension-note" role="status">
          {note}
        </p>
      )}
    </>
  );
}

/** Same shell as `SettingsApp`'s `Group`. */
function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="settings-group">
      <h2>{title}</h2>
      <div className="settings-card">{children}</div>
      {note && <p className="settings-note">{note}</p>}
    </section>
  );
}

/** Same row as `SettingsApp`'s `Row`. */
function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <span className="settings-label">{label}</span>
      {children}
    </div>
  );
}
