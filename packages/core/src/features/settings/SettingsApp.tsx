import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DEFAULT_API_PROXY_DOMAIN } from "@/lib/constants";
import { loadConfig, resetConfig, setCheckbox, writeConfig } from "@/lib/config";
import type { TremConfig } from "@/lib/types";

const SOUND_EFFECTS: { key: string; label: string; locked?: boolean }[] = [
  { key: "sound-effects-dong", label: "警報提示音（dong）", locked: true },
  { key: "sound-effects-EEW", label: "地震速報音效" },
  { key: "sound-effects-EEW2", label: "緊急地震速報音效（警報）" },
  { key: "sound-effects-PAlert", label: "P-Alert / 震度速報音效" },
  { key: "sound-effects-PGA1", label: "PGA 一級音效" },
  { key: "sound-effects-PGA2", label: "PGA 二級音效" },
  { key: "sound-effects-Report", label: "地震報告音效" },
  { key: "sound-effects-Shindo0", label: "弱反應音效" },
  { key: "sound-effects-Shindo1", label: "震動檢測音效" },
  { key: "sound-effects-Shindo2", label: "強震檢測音效" },
  { key: "sound-effects-Update", label: "更新報數音效" },
];

const WINDOW_TOGGLES: { key: string; label: string }[] = [
  { key: "show-window-eew", label: "顯示地震速報視窗" },
  { key: "show-window-report", label: "顯示地震報告視窗" },
  { key: "show-window-detect", label: "顯示強震檢測視窗" },
  { key: "show-window-rts-intensity", label: "顯示即時震度視窗" },
  { key: "early-warning-trem-eew", label: "啟用 TREM-EEW 速報" },
  { key: "ota-auto-update", label: "自動更新" },
];

export function SettingsApp() {
  const [config, setConfig] = useState<TremConfig | null>(null);
  const [version, setVersion] = useState("");
  const [proxy, setProxy] = useState("");

  useEffect(() => {
    loadConfig(true).then((c) => {
      setConfig(c);
      setProxy(c.apiProxyDomain);
    });
    getVersion().then(setVersion).catch(() => { });
  }, []);

  if (!config) {
    return <div className="flex h-screen items-center justify-center text-muted-foreground">載入中…</div>;
  }

  const toggle = async (key: string, value: boolean) => {
    await setCheckbox(key, value);
    setConfig({ ...config, "check-box": { ...config["check-box"], [key]: value } });
  };

  const saveProxy = async (value: string) => {
    const next = { ...config, apiProxyDomain: value || DEFAULT_API_PROXY_DOMAIN };
    await writeConfig(next);
    setConfig(next);
    setProxy(next.apiProxyDomain);
  };

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <TitleBar />
      <div className="flex-1 overflow-hidden p-4">
        <Tabs defaultValue="general" className="flex h-full flex-col">
          <TabsList className="self-start">
            <TabsTrigger value="general">一般</TabsTrigger>
            <TabsTrigger value="graphics">畫面</TabsTrigger>
            <TabsTrigger value="sound">音效</TabsTrigger>
            <TabsTrigger value="extended">擴充</TabsTrigger>
            <TabsTrigger value="info">關於</TabsTrigger>
          </TabsList>

          <div className="mt-3 flex-1 pr-2">
            <TabsContent value="general">
              <Section title="視窗與功能">
                {WINDOW_TOGGLES.map((t) => (
                  <ToggleRow
                    key={t.key}
                    label={t.label}
                    checked={!!config["check-box"][t.key]}
                    onChange={(v) => toggle(t.key, v)}
                  />
                ))}
              </Section>
              <Section title="API Proxy 網域">
                <div className="flex items-center gap-2">
                  <Input value={proxy} onChange={(e) => setProxy(e.target.value)} className="max-w-xs" />
                  <Button size="sm" onClick={() => saveProxy(proxy)}>
                    儲存
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => saveProxy(DEFAULT_API_PROXY_DOMAIN)}>
                    重設
                  </Button>
                </div>
              </Section>
            </TabsContent>

            <TabsContent value="graphics">
              <Section title="畫面">
                <ToggleRow
                  label="停用自動縮放"
                  checked={!!config["check-box"]["graphics-block-auto-zoom"]}
                  onChange={(v) => toggle("graphics-block-auto-zoom", v)}
                />
              </Section>
            </TabsContent>

            <TabsContent value="sound">
              <Section title="音效（全部由 Rust 播放）">
                {SOUND_EFFECTS.map((s) => (
                  <ToggleRow
                    key={s.key}
                    label={s.label}
                    checked={!!config["check-box"][s.key]}
                    disabled={s.locked}
                    onChange={(v) => toggle(s.key, v)}
                  />
                ))}
              </Section>
            </TabsContent>

            <TabsContent value="extended">
              <Section title="擴充套件">
                <p className="text-sm text-muted-foreground">
                  擴充套件系統將於後續版本以沙箱化 Web 外掛重新設計，敬請期待。
                </p>
              </Section>
            </TabsContent>

            <TabsContent value="info">
              <Section title="關於">
                <div className="space-y-1 text-sm">
                  <div>TREM-Lite v{version}</div>
                  <div className="text-muted-foreground">Taiwan Real-time Earthquake Monitoring</div>
                  <div className="text-muted-foreground">© ExpTech Studio</div>
                </div>
                <div className="mt-4">
                  <Button variant="destructive" size="sm" onClick={() => resetConfig().then(setConfig)}>
                    重設所有設定
                  </Button>
                </div>
              </Section>
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </div>
  );
}

function TitleBar() {
  const win = getCurrentWindow();
  return (
    <div
      data-tauri-drag-region
      className="flex h-9 items-center justify-between border-b border-border px-3"
    >
      <span className="text-sm font-semibold">TREM-Lite 設定</span>
      <div className="flex gap-1">
        <button onClick={() => win.minimize()} className="rounded p-1 hover:bg-accent">
          <Minus className="h-4 w-4" />
        </button>
        <button onClick={() => win.close()} className="rounded p-1 hover:bg-destructive hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{title}</h3>
      <div className="space-y-1 rounded-lg border border-border p-2">{children}</div>
    </section>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-2 py-1.5 border-b border-[#ffffff05] hover:bg-accent/50 last:border-b-0">
      <span className="text-sm">{label}</span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}
