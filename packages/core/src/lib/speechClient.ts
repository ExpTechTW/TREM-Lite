/** zh-TW speech announcements corresponding to the legacy speak-tts wiring. */
import { extractLocation, int_to_string, search_loc_name } from "@/domain/utils";

import { INTENSITY_LIST, SHOW_TREM_EEW } from "./constants";
import { getConfig } from "./config";
import { events } from "./events";
import type { ReportListItem } from "./types";
import { variable } from "./variable";

interface EewSpeechState {
  lastLoc: string;
  lastIntensity: number;
  loc: string;
  intensity: number;
}

const cache = new Map<string, EewSpeechState>();
let initialized = false;
let areaAlertSpeaking = false;

function available(): boolean {
  return "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

function enabled(): boolean {
  return available() && !!getConfig()["check-box"]["other-tts"];
}

function speak(text: string, queue = true, onEnd?: () => void): void {
  if (!enabled()) return;
  if (!queue) window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "zh-TW";
  utterance.rate = 1;
  if (onEnd) {
    utterance.onend = onEnd;
    utterance.onerror = onEnd;
  }
  window.speechSynthesis.speak(utterance);
}

function chineseTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日${date.getHours()}點${date.getMinutes()}分`;
}

function pronunciation(text: string): string {
  return text
    .replace("2.", "二點")
    .replaceAll(".2", "點二")
    .replaceAll("三地門", "三弟門")
    .replaceAll(".", "點")
    .replaceAll("為", "圍");
}

function announceReport(data: ReportListItem): void {
  const stations: Record<number, string[]> = {};
  let maximum = 0;
  for (const [county, countyData] of Object.entries(data.list ?? {})) {
    maximum = Math.max(maximum, countyData.int);
    for (const [town, townData] of Object.entries(countyData.town)) {
      (stations[townData.int] ??= []).push(`${county}${town}`);
    }
  }

  let text = [
    "地震報告",
    chineseTime(data.time),
    `發生最大震度 ${int_to_string(maximum)} 地震`,
    `震央位於 ${extractLocation(data.loc)}`,
    `震央深度為 ${data.depth}公里`,
    `地震規模為 ${data.mag.toFixed(1)}`,
  ].join("，");

  let described = 0;
  for (let intensity = 9; intensity >= 1 && described < 3; intensity--) {
    const places = stations[intensity];
    if (!places?.length) continue;
    const lead = described === 0 ? "這次地震，最大" : described === 1 ? "此外" : "";
    text += `，${lead}震度 ${int_to_string(intensity)} 地區 ${places.join("，")}`;
    described++;
  }
  speak(pronunciation(text), false);
}

function announceLpgm(data: { id: number; time: number; list: { id: number; lpgm: number }[] }): void {
  const stations: Record<number, string[]> = {};
  let maximum = 0;
  let maxCity = "";
  for (const item of data.list) {
    if (!item.lpgm) continue;
    const station = variable.station?.[item.id]?.info.at(-1);
    const location = station ? search_loc_name(station.code) : null;
    if (!location) continue;
    (stations[item.lpgm] ??= []).push(`${location.city}${location.town}`);
    if (item.lpgm > maximum) {
      maximum = item.lpgm;
      maxCity = location.city;
    }
  }

  let text = `長週期地震動觀測資訊，${chineseTime(data.id)}，${maxCity}觀測到最大長週期地震動階級${maximum}`;
  let described = 0;
  for (let level = 4; level >= 1 && described < 3; level--) {
    const places = stations[level];
    if (!places?.length) continue;
    const lead = described === 0 ? "這次地震，最大" : described === 1 ? "此外" : "";
    text += `，${lead}長週期地震動階級 ${level} 地區 ${places.join("，")}`;
    described++;
  }
  speak(pronunciation(text), false);
}

export function initSpeech(): void {
  if (initialized) return;
  initialized = true;
  variable.tts = enabled();

  events.on("EewRelease", ({ data }) => {
    if (!SHOW_TREM_EEW && data.author === "trem") return;
    cache.set(data.id, {
      lastLoc: "",
      lastIntensity: -1,
      loc: data.eq.loc,
      intensity: data.eq.max,
    });
  });
  events.on("EewUpdate", ({ data }) => {
    if (!SHOW_TREM_EEW && data.author === "trem") return;
    const state = cache.get(data.id);
    if (state) {
      state.loc = data.eq.loc;
      state.intensity = data.eq.max;
    } else {
      cache.set(data.id, {
        lastLoc: "",
        lastIntensity: -1,
        loc: data.eq.loc,
        intensity: data.eq.max,
      });
    }
  });
  events.on("EewEnd", ({ data }) => cache.delete(data.id));

  events.on("EewNewAreaAlert", ({ data }) => {
    if (!enabled()) return;
    areaAlertSpeaking = true;
    speak(
      `緊急地震速報，${data.city_alert_list.join("、")}，慎防強烈搖晃`,
      false,
      () => {
        areaAlertSpeaking = false;
      },
    );
  });

  const announceIntensity = (data: { max: number; area: Record<number, number[]> }) => {
    if (variable.cache.intensity.max >= data.max) return;
    const max = Math.max(data.max, ...Object.keys(data.area).map(Number));
    const cities = new Set<string>();
    for (const code of data.area[max] ?? []) {
      const location = search_loc_name(code);
      if (location) cities.add(location.city);
    }
    const locations = [...cities];
    speak(
      `震度速報，震度${INTENSITY_LIST[max] ?? max}${locations.length ? `，${locations.join("、")}` : ""}`,
    );
  };
  events.on("IntensityRelease", ({ data }) => announceIntensity(data));
  events.on("IntensityUpdate", ({ data }) => announceIntensity(data));
  events.on("ReportRelease", ({ data }) => announceReport(data));
  events.on("LpgmRelease", ({ data }) => announceLpgm(data));

  window.setInterval(() => {
    if (!enabled() || areaAlertSpeaking) return;
    for (const state of cache.values()) {
      if (state.intensity <= state.lastIntensity) continue;
      if (state.loc !== state.lastLoc) {
        state.lastLoc = state.loc;
        speak(`${state.loc}發生地震`);
      }
      state.lastIntensity = state.intensity;
      const intensity = state.intensity ? INTENSITY_LIST[state.intensity] : "不明";
      speak(`預估最大震度${intensity?.replace("⁻", "弱").replace("⁺", "強")}`);
    }
  }, 3000);
}
