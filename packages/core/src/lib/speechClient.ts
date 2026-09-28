/** zh-TW speech announcements corresponding to the legacy speak-tts wiring. */
import { extractLocation, int_to_string, search_loc_name } from "@/domain/utils";

import { INTENSITY_LIST } from "./constants";
import { getConfig } from "./config";
import { events } from "./events";
import { createLogger } from "./logger";
import type { ReportListItem } from "./types";
import { variable } from "./variable";

interface EewSpeechState {
  lastLoc: string;
  lastIntensity: number;
  loc: string;
  intensity: number;
}

const log = createLogger("speech");

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
  if (!enabled()) {
    log.debug(`語音${available() ? "設定關閉" : "在這個環境無法使用"}，不念：${text}`);
    return;
  }
  if (!queue) window.speechSynthesis.cancel();
  log.info(`語音${queue ? "" : "（插隊，先停掉正在念的）"}：${text}`);
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "zh-TW";
  utterance.rate = 1;
  utterance.onend = () => onEnd?.();
  utterance.onerror = (e) => {
    // `interrupted` and `canceled` are ours: a newer announcement or a stop.
    if (e.error !== "interrupted" && e.error !== "canceled") log.warn(`語音失敗（${e.error}）：${text}`);
    onEnd?.();
  };
  window.speechSynthesis.speak(utterance);
}

/**
 * A browser speaks nothing a page asks for before it has been interacted
 * with. Saying nothing, inside a click, lifts that for the page's lifetime.
 */
export function unlockSpeech(): void {
  if (available()) window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
}

/** Drop what is being said and what is queued — at a live/replay boundary. */
export function stopSpeech(): void {
  log.info("停止語音（念到一半的與排隊中的）");
  if (available()) window.speechSynthesis.cancel();
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

/** How long an update is shown when there is no speech to wait for. */
const UNSPOKEN_UPDATE_MS = 15_000;

function announceReport(data: ReportListItem, update: boolean, onEnd?: () => void): void {
  const stations: Record<number, string[]> = {};
  let maximum = 0;
  for (const [county, countyData] of Object.entries(data.list ?? {})) {
    maximum = Math.max(maximum, countyData.int);
    for (const [town, townData] of Object.entries(countyData.town)) {
      (stations[townData.int] ??= []).push(`${county}${town}`);
    }
  }

  let text = [
    update ? "地震報告更新" : "地震報告",
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
  speak(pronunciation(text), false, onEnd);
}

function announceLpgm(data: { id: number; time: number; list: { id: number; lpgm: number }[] }): void {
  const stations: Record<number, string[]> = {};
  let maximum = 0;
  let maxCity = "";
  for (const item of data.list) {
    if (!item.lpgm) continue;
    const station = variable.legacyStation?.[item.id]?.info.at(-1);
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
    cache.set(data.id, {
      lastLoc: "",
      lastIntensity: -1,
      loc: data.eq.loc,
      intensity: data.eq.max,
    });
  });
  events.on("EewUpdate", ({ data }) => {
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
  // An update stays on the map until its announcement ends (see report.ts),
  // so the end is always reported: when spoken, when cut off, or — with speech
  // off — after as long as reading it would take.
  events.on("ReportRelease", ({ data, update }) => {
    const done = update ? () => events.emit("ReportSpeechEnd", { id: data.id }) : undefined;
    if (!enabled()) {
      if (done) setTimeout(done, UNSPOKEN_UPDATE_MS);
      return;
    }
    announceReport(data, !!update, done);
  });
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
