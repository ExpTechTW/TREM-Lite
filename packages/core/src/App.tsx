import { useEffect, useState } from "react";

import { createLogger } from "@/lib/logger";
import { mark } from "@/lib/perf";
import { loadConfig, onConfigUpdated } from "@/lib/config";
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

      {/* overlays */}
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
  );
}
