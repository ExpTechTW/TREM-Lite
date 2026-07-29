/**
 * Overlay preview harness — renders every overlay with mock data on a dark map
 * background, WITHOUT the Tauri backend, so Playwright can screenshot it and the
 * layout can be tuned against the legacy reference. Not shipped (dev-only entry).
 */
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import "@/styles/globals.css";

import { events } from "@/lib/events";
import { ui } from "@/lib/variable.ui";
import { variable } from "@/lib/variable";
import type { ReportListItem } from "@/lib/types";

import { EewInfoBox } from "@/overlays/EewInfoBox";
import { IntensityLegend } from "@/overlays/IntensityLegend";
import { MaxIntensity } from "@/overlays/MaxIntensity";
import { NavBar } from "@/overlays/NavBar";
import { ReportPanel } from "@/overlays/ReportPanel";
import { RtsIntensityList } from "@/overlays/RtsIntensityList";
import { StationReadout } from "@/overlays/StationReadout";
import { VersionBadge } from "@/overlays/VersionBadge";
import { WarningBanners } from "@/overlays/WarningBanners";

// ---- mock live state (quiet, matches the legacy idle screenshot) ----
ui.currentEew = null; // idle → "暫無生效中的地震預警"
ui.maxIntensity = { i: 0, label: "0級" };
ui.maxPga = 3.98;
ui.currentStation = { loc: "臺南市歸仁區", i: 0, pga: 3.98 };
ui.rtsInfo = { level: 0, trigger: 0 };

// a few realtime intensity rows (region codes that resolve via search_loc_name)
variable.data.rts = {
  station: {},
  box: {},
  int: [
    { code: 202, i: 2 },
    { code: 205, i: 1 },
    { code: 206, i: 1 },
  ],
  time: Date.now(),
} as never;

const mockReports: ReportListItem[] = [
  { id: "115000-2026-0702-114500", lat: 24.0, lon: 121.6, depth: 14.1, loc: "花蓮縣秀林鄉", mag: 3.5, time: Date.now() - 3_600_000, int: 2, trem: 0 },
  { id: "115049-2026-0702-090100", lat: 22.9, lon: 121.0, depth: 20, loc: "臺灣南部海域", mag: 4.0, time: Date.now() - 8_000_000, int: 2, trem: 0 },
  { id: "115000-2026-0702-070600", lat: 24.1, lon: 121.6, depth: 10, loc: "花蓮縣豐濱鄉", mag: 4.0, time: Date.now() - 12_000_000, int: 4, trem: 0 },
  { id: "115000-2026-0702-003100", lat: 24.5, lon: 122.0, depth: 30, loc: "臺灣東部海域", mag: 4.3, time: Date.now() - 20_000_000, int: 2, trem: 0 },
  { id: "115000-2026-0630-051500", lat: 24.5, lon: 122.2, depth: 40, loc: "臺灣東部海域", mag: 5.0, time: Date.now() - 90_000_000, int: 2, trem: 0 },
  { id: "115000-2026-0629-092000", lat: 24.0, lon: 121.6, depth: 12, loc: "花蓮縣秀林鄉", mag: 3.6, time: Date.now() - 100_000_000, int: 2, trem: 0 },
  { id: "115000-2026-0625-053000", lat: 23.4, lon: 120.5, depth: 8, loc: "嘉義縣中埔鄉", mag: 3.1, time: Date.now() - 140_000_000, int: 2, trem: 0 },
  { id: "115000-2026-0621-103700", lat: 23.5, lon: 120.4, depth: 15, loc: "嘉義市西區", mag: 3.5, time: Date.now() - 180_000_000, int: 3, trem: 0 },
];
variable.data.report = mockReports as never;

function PreviewApp() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // drive event-based overlays
    events.emit("DataRts", { info: { type: 0 }, data: variable.data.rts as never });
    events.emit("ReportRelease", { data: mockReports[0] });
    setReady(true);
  }, []);

  return (
    <div className="relative h-screen w-screen overflow-hidden" style={{ background: "#1f2025" }}>
      {ready && (
        <>
          <EewInfoBox />
          <IntensityLegend />
          <MaxIntensity />
          <StationReadout />
          <RtsIntensityList />
          <ReportPanel />
          <WarningBanners />
          <NavBar />
          <VersionBadge />
        </>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<PreviewApp />);
