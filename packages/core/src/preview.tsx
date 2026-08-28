/**
 * Overlay preview harness — renders every overlay with mock data on a dark map
 * background, WITHOUT the Tauri backend, so Playwright can screenshot it and the
 * layout can be tuned against the legacy reference. Not shipped (dev-only entry).
 */
import { useEffect } from "react";
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

// ---- mock live state (quiet by default; query states exercise every branch) ----
const previewState = new URLSearchParams(window.location.search).get("state") ?? "idle";
const previewNow = new Date("2026-08-28T07:26:30+08:00").getTime();

ui.currentEew = null;
ui.currentTrigger = null;
ui.maxIntensity = { i: 0, label: "0級" };
ui.maxPga = 3.98;
ui.currentStation = { loc: "臺南市歸仁區", i: 0, rawI: -3, pga: 0.49 };
ui.rtsInfo = { level: 0, trigger: 0 };
ui.rtsIntensityRows = [];

if (previewState === "trigger") {
  ui.currentTrigger = {
    max: 4,
    locations: [
      { i: 4, name: "花蓮縣秀林鄉" },
      { i: 4, name: "花蓮縣壽豐鄉" },
      { i: 3, name: "宜蘭縣南澳鄉" },
      { i: 3, name: "臺東縣海端鄉" },
    ],
  };
} else if (previewState === "eew" || previewState === "cancel") {
  ui.currentEew = {
    id: "preview-eew",
    statusClass: previewState === "cancel" ? "eew-cancel" : "eew-alert",
    serial: 3,
    final: false,
    unitText: "CWA",
    loc: "花蓮縣近海",
    depth: 18,
    mag: 5.8,
    max: 6,
    nsspe: false,
    time: new Date("2026-08-28T07:25:29+08:00").getTime(),
  };
} else if (previewState === "rts") {
  ui.rtsIntensityRows = [
    { i: 4, name: "花蓮縣" },
    { i: 3, name: "宜蘭縣" },
    { i: 2, name: "臺東縣" },
  ];
} else if (previewState === "warnings") {
  ui.internetError = true;
  ui.unstable = true;
}

// a few realtime intensity rows (region codes that resolve via search_loc_name)
variable.data.rts = {
  station: {},
  box: {},
  int: [
    { code: 202, i: 2 },
    { code: 205, i: 1 },
    { code: 206, i: 1 },
  ],
  time: previewNow,
} as never;

const mockReports: ReportListItem[] = [
  { id: "115000-2026-0702-114500", lat: 24.0, lon: 121.6, depth: 14.1, loc: "花蓮縣秀林鄉", mag: 3.5, time: previewNow - 3_600_000, int: 2, trem: 0 },
  { id: "115049-2026-0702-090100", lat: 22.9, lon: 121.0, depth: 20, loc: "臺灣南部海域", mag: 4.0, time: previewNow - 8_000_000, int: 2, trem: 0 },
  { id: "115000-2026-0702-070600", lat: 24.1, lon: 121.6, depth: 10, loc: "花蓮縣豐濱鄉", mag: 4.0, time: previewNow - 12_000_000, int: 4, trem: 0 },
  { id: "115000-2026-0702-003100", lat: 24.5, lon: 122.0, depth: 30, loc: "臺灣東部海域", mag: 4.3, time: previewNow - 20_000_000, int: 2, trem: 0 },
  { id: "115000-2026-0630-051500", lat: 24.5, lon: 122.2, depth: 40, loc: "臺灣東部海域", mag: 5.0, time: previewNow - 90_000_000, int: 2, trem: 0 },
  { id: "115000-2026-0629-092000", lat: 24.0, lon: 121.6, depth: 12, loc: "花蓮縣秀林鄉", mag: 3.6, time: previewNow - 100_000_000, int: 2, trem: 0 },
  { id: "115000-2026-0625-053000", lat: 23.4, lon: 120.5, depth: 8, loc: "嘉義縣中埔鄉", mag: 3.1, time: previewNow - 140_000_000, int: 2, trem: 0 },
  { id: "115000-2026-0621-103700", lat: 23.5, lon: 120.4, depth: 15, loc: "嘉義市西區", mag: 3.5, time: previewNow - 180_000_000, int: 3, trem: 0 },
];
variable.data.report = mockReports as never;

if (previewState === "survey") {
  variable.cache.intensity = { time: previewNow - 90_000, max: 5 };
}

function PreviewApp() {
  useEffect(() => {
    // drive event-based overlays
    events.emit("DataRts", { info: { type: 0 }, data: variable.data.rts as never });
    events.emit("ReportRelease", { data: mockReports[0] });
    events.emit("EewDisplayUpdate");
  }, []);

  return (
    <div className="relative h-screen w-screen overflow-hidden" style={{ background: "#1f2025" }}>
      <EewInfoBox />
      <IntensityLegend />
      <MaxIntensity />
      <StationReadout />
      <ReportPanel />
      <RtsIntensityList />
      <WarningBanners />
      <NavBar />
      <VersionBadge />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<PreviewApp />);
