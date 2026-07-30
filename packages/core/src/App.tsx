import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";

import tremLogo from "@/assets/trem.png";
import { createLogger } from "@/lib/logger";
import { mark } from "@/lib/perf";
import { loadConfig, onConfigUpdated } from "@/lib/config";
import { inTauri } from "@/lib/env";
import { MapView } from "@/features/map/MapView";
import { EewInfoBox } from "@/overlays/EewInfoBox";
import { IntensityLegend } from "@/overlays/IntensityLegend";
import { MaxIntensity } from "@/overlays/MaxIntensity";
import { NavBar } from "@/overlays/NavBar";
import { ReportPanel } from "@/overlays/ReportPanel";
import { RtsIntensityList } from "@/overlays/RtsIntensityList";
import { StationReadout } from "@/overlays/StationReadout";
import { VersionBadge } from "@/overlays/VersionBadge";
import { WarningBanners } from "@/overlays/WarningBanners";

const log = createLogger("app");

/** Main window. Loads config before booting the map + data + audio pipeline. */
export function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let un: (() => void) | undefined;
    loadConfig()
      .then(async () => {
        mark("config-loaded");
        setReady(true);
        un = await onConfigUpdated(() => {});
      })
      .catch((e) => {
        log.error("config load failed", e);
        setReady(true); // still show the map with defaults
      });
    return () => un?.();
  }, []);

  if (!ready) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background text-muted-foreground">
        載入中…
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-background text-foreground">
      <MapView />
      {inTauri && <MainTitleBar />}

      {/* overlays */}
      <div className={inTauri ? "pointer-events-none absolute inset-x-0 bottom-0 top-9" : "pointer-events-none absolute inset-0"}>
        <EewInfoBox />
        <IntensityLegend />
        <MaxIntensity />
        <StationReadout />
        <RtsIntensityList />
        <ReportPanel />
        <WarningBanners />
        <NavBar />
        <VersionBadge />
      </div>
    </div>
  );
}

function MainTitleBar() {
  const win = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let mounted = true;

    const syncMaximized = async () => {
      const next = await win.isMaximized();
      if (mounted) setMaximized(next);
    };

    syncMaximized().catch(() => {});
    const unlisten = win.onResized(() => {
      void syncMaximized();
    });

    return () => {
      mounted = false;
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [win]);

  const toggleMaximize = async () => {
    if (await win.isMaximized()) {
      await win.unmaximize();
      setMaximized(false);
      return;
    }
    await win.maximize();
    setMaximized(true);
  };

  return (
    <header className="absolute left-0 right-0 top-0 z-50 flex h-9 items-center border-b border-white/10 bg-[#1f1f23]/90 text-[var(--light)] backdrop-blur-sm">
      <div
        data-tauri-drag-region
        className="flex h-full flex-1 items-center justify-between gap-3 px-3"
        onDoubleClick={() => void toggleMaximize()}
      >
        <div className="flex min-w-0 items-center gap-1">
          <img src={tremLogo} alt="TREM-Lite" className="h-4.5 w-4.5 shrink-0 rounded-sm" />
          <div className="truncate text-sm font-semibold">TREM-Lite</div>
        </div>
      </div>

      <div className="flex h-full items-stretch">
        <TitleBarButton title="最小化" onClick={() => void win.minimize()}>
          <Minus className="h-4 w-4" />
        </TitleBarButton>
        <TitleBarButton title={maximized ? "還原" : "最大化"} onClick={() => void toggleMaximize()}>
          {maximized ? <Copy className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
        </TitleBarButton>
        <TitleBarButton title="關閉" danger onClick={() => void win.close()}>
          <X className="h-4 w-4" />
        </TitleBarButton>
      </div>
    </header>
  );
}

function TitleBarButton({
  children,
  title,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={
        danger
          ? "flex h-9 w-12 items-center justify-center transition-colors hover:bg-[#e81123] hover:text-white"
          : "flex h-9 w-12 items-center justify-center transition-colors hover:bg-white/10"
      }
    >
      {children}
    </button>
  );
}
