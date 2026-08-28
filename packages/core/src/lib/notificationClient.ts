/** Desktop notifications ported from legacy core/audio.js. */
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import { formatTimestamp, int_to_string, search_loc_name } from "@/domain/utils";
import { SHOW_TREM_EEW } from "./constants";
import { inTauri } from "./env";
import { events } from "./events";
import type { EewData, ReportListItem } from "./types";
import { variable } from "./variable";

let initialized = false;
let permission: boolean | null = null;

export async function sendDesktopNotification(title: string, body: string): Promise<void> {
  if (!inTauri) return;
  try {
    if (permission == null) {
      permission = await isPermissionGranted();
      if (!permission) permission = (await requestPermission()) === "granted";
    }
    if (permission) sendNotification({ title, body });
  } catch {
    // Notifications are supplementary; a denied OS permission must not affect alerts.
  }
}

function reportMaximum(report: ReportListItem): { intensity: number; county: string } {
  let intensity = 0;
  let county = "";
  for (const [name, value] of Object.entries(report.list ?? {})) {
    if (value.int > intensity) {
      intensity = value.int;
      county = name;
    }
  }
  return { intensity, county };
}

function intensityCities(area: Record<number, number[]>): { intensity: number; cities: string[] } {
  const intensity = Math.max(0, ...Object.keys(area).map(Number));
  const cities = new Set<string>();
  for (const code of area[intensity] ?? []) {
    const location = search_loc_name(code);
    if (location) cities.add(location.city);
  }
  return { intensity, cities: [...cities] };
}

export function initNotifications(): void {
  if (initialized) return;
  initialized = true;

  const eewNotice = (data: EewData) => {
    if (!SHOW_TREM_EEW && data.author === "trem") return;
    const kind = data.status === 1 ? "🚨 緊急地震速報" : "⚠️ 地震速報";
    void sendDesktopNotification(
      `${kind} ${data.serial}報`,
      `${formatTimestamp(data.eq.time)} 最大預估 ${int_to_string(data.eq.max)}\n${data.eq.loc} M${data.eq.mag} ${data.eq.depth}km`,
    );
  };

  events.on("EewRelease", ({ data }) => eewNotice(data));
  events.on("EewUpdate", ({ data }) => eewNotice(data));
  events.on("EewCancel", ({ data }) => {
    void sendDesktopNotification(
      `⚠️ 地震速報 ${data.serial}報（取消）`,
      `${formatTimestamp(data.eq.time)} 最大預估不明\n${data.eq.loc}`,
    );
  });

  events.on("RtsShindo2", () => void sendDesktopNotification("🟥 強震檢測", "請注意今後的資訊。"));
  events.on("RtsShindo1", () => void sendDesktopNotification("🟧 震動檢測", "請注意今後的資訊。"));
  events.on("RtsShindo0", () => void sendDesktopNotification("🟩 弱反應", "請注意今後的資訊。"));

  events.on("ReportRelease", ({ data }) => {
    const maximum = reportMaximum(data);
    const id = data.id.split("-")[0];
    const label = id.includes("000") ? "小區域有感地震" : id;
    void sendDesktopNotification(
      `🔔 地震報告 [${label}]`,
      `${formatTimestamp(data.time)} ${data.loc} M${data.mag.toFixed(1)}，${maximum.county}最大震度${int_to_string(maximum.intensity)}。`,
    );
  });

  const intensityNotice = (data: { id: number; max: number; area: Record<number, number[]> }) => {
    if (variable.cache.intensity.max >= data.max) return;
    const maximum = intensityCities(data.area);
    void sendDesktopNotification(
      `📨 震度速報 [${formatTimestamp(data.id)}]`,
      `震度${int_to_string(maximum.intensity)} ${maximum.cities.join("、")}`,
    );
  };
  events.on("IntensityRelease", ({ data }) => intensityNotice(data));
  events.on("IntensityUpdate", ({ data }) => intensityNotice(data));

  events.on("LpgmRelease", ({ data }) => {
    let max = 0;
    let city = "";
    for (const item of data.list) {
      if (item.lpgm <= max) continue;
      const station = variable.station?.[item.id]?.info.at(-1);
      const location = station ? search_loc_name(station.code) : null;
      max = item.lpgm;
      city = location?.city ?? city;
    }
    void sendDesktopNotification("🔔 長週期地震動", `${city}觀測到最大長週期地震動階級${max}。`);
  });
}
