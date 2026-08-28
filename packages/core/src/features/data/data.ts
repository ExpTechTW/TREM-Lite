/**
 * Data ingestion state machine — ported from legacy/src/js/index/data/data.js.
 * SSE (live) / HTTP polling / file-replay, normalizing payloads and emitting all
 * the domain lifecycle events. Replay files use tauri-plugin-fs instead of fs-extra.
 */
import { readDir, readTextFile, BaseDirectory } from "@tauri-apps/plugin-fs";

import { HTTP_TIMEOUT, LAST_DATA_TIMEOUT_ERROR, EEW_AUTHOR } from "@/lib/constants";
import { events } from "@/lib/events";
import { now } from "@/lib/ntp";
import { variable } from "@/lib/variable";
import { ui } from "@/lib/variable.ui";
import type { EewData } from "@/lib/types";

import { abortAll, init as sseInit, getData, type SseManager } from "./dataHttp";

let fileList: string[] = [];
let fileIndex = 0;

const ORIGINAL: Record<string, number> = { LOOP: HTTP_TIMEOUT.LOOP, RTS: HTTP_TIMEOUT.RTS, EEW: HTTP_TIMEOUT.EEW };
// Mutable copy — the adaptive timeout manager tunes these at runtime.
const TIMEOUT: Record<string, number> = { ...HTTP_TIMEOUT };

class TimeoutManager {
  private MAX = 10000;
  private STEP = 500;
  private lastAdjust = Date.now();
  private failureCount = 0;

  adjustTimeouts(data: { eew: unknown; rts: unknown }): boolean {
    const t = Date.now();
    if (t - this.lastAdjust < 2000) return true;
    this.lastAdjust = t;

    if (!data.eew && !data.rts) {
      this.failureCount = Math.min(this.failureCount + 1, 10);
      const inc = this.STEP * this.failureCount;
      (["LOOP", "RTS", "EEW"] as const).forEach((type) => {
        TIMEOUT[type] = Math.min(TIMEOUT[type] + inc, this.MAX);
      });
      return false;
    }

    this.failureCount = Math.max(0, Math.floor(this.failureCount / 2));
    if (TIMEOUT.LOOP <= ORIGINAL.LOOP) return true;
    const dec = this.STEP * (this.failureCount + 1);
    (["LOOP", "RTS", "EEW"] as const).forEach((type) => {
      TIMEOUT[type] = Math.max(ORIGINAL[type], TIMEOUT[type] - dec);
    });
    return true;
  }
}

const timeoutManager = new TimeoutManager();

class DataManager {
  private lastFetchTime = 0;
  private fetchInterval: ReturnType<typeof setInterval> | null = null;
  private mapInitialized = false;
  private sseActive = false;
  private sseManager: SseManager | null = null;
  private sseHandled = false;
  private transportEpoch = 0;

  constructor() {
    this.initialize();
  }

  private initialize() {
    events.on("MapLoad", () => {
      if (this.mapInitialized) return;
      this.mapInitialized = true;
      if (this.fetchInterval) clearInterval(this.fetchInterval);
      this.fetchInterval = setInterval(() => void this.fetchData(), 100);
    });

    // Detect replay files under <appData>/replay.
    void this.detectReplay();
  }

  private async detectReplay() {
    const detectionEpoch = this.transportEpoch;
    const detectionMode = variable.play_mode;
    try {
      const entries = await readDir("replay", { baseDir: BaseDirectory.AppData });
      if (detectionEpoch !== this.transportEpoch || detectionMode !== variable.play_mode) return;
      const frames = entries
        .flatMap((entry) => {
          const name = entry.name;
          if (!name || !/^\d+\.json$/.test(name)) return [];
          const time = Number(name.slice(0, -5));
          return Number.isSafeInteger(time) && time > 0 ? [{ name, time }] : [];
        })
        .sort((a, b) => a.time - b.time);
      if (frames.length) {
        this.resetTransport();
        fileList = frames.map((frame) => frame.name);
        fileIndex = 0;
        variable.play_mode = 3;
        variable.replay = { start_time: frames[0].time, local_time: 0, dev: false };
        this.clearDomainState(3);
        events.emit("ReplayStateChange", { active: true });
      }
    } catch {
      /* no replay dir — stay in live mode */
    }
  }

  async fetchData(): Promise<void> {
    const localNow = Date.now();
    if (localNow - this.lastFetchTime < TIMEOUT.LOOP) return;
    this.lastFetchTime = localNow;

    if (variable.play_mode === 0) this.startSSE();
    if (variable.play_mode === 3) this.stopSSE();

    if (this.sseActive) return;

    if (variable.play_mode === 3) {
      if (fileIndex >= fileList.length) {
        this.resetTransport();
        variable.play_mode = 0;
        variable.replay = { start_time: 0, local_time: 0, dev: false };
        this.clearDomainState(0);
        events.emit("ReplayStateChange", { active: false });
        return;
      }
      const fileName = fileList[fileIndex++];
      const fileEpoch = this.transportEpoch;
      const fileMode = variable.play_mode;
      try {
        const text = await readTextFile(`replay/${fileName}`, {
          baseDir: BaseDirectory.AppData,
        });
        if (fileEpoch !== this.transportEpoch || fileMode !== variable.play_mode) return;
        const json = JSON.parse(text);
        variable.data.rts = json.rts;
        events.emit("DataRts", { info: { type: variable.play_mode }, data: json.rts });
        this.processEEWData(json.eew);
        this.processIntensityData(json.intensity);
      } catch {
        /* ignore bad replay frame */
      }
      return;
    }

    if (this.sseHandled) {
      this.sseHandled = false;
      return;
    }

    const requestEpoch = this.transportEpoch;
    const requestMode = variable.play_mode;
    const data = await getData(
      variable.play_mode == 0 || variable.play_mode == 1 ? undefined : now(),
    );

    // A replay/live transition may occur while HTTP responses or response
    // bodies are pending. Never process a result from the previous mode/epoch.
    if (requestEpoch !== this.transportEpoch || requestMode !== variable.play_mode) return;

    if (!timeoutManager.adjustTimeouts({ eew: data.eew, rts: data.rts })) return;

    if (variable.play_mode == 0 || variable.play_mode == 2) {
      const rts = data.rts as { time?: number } | null;
      if (
        !variable.data.rts ||
        (!data.rts && localNow - variable.cache.last_data_time > LAST_DATA_TIMEOUT_ERROR) ||
        (variable.data.rts.time ?? 0) < (rts?.time ?? 0)
      ) {
        variable.data.rts = data.rts as never;
        events.emit("DataRts", { info: { type: variable.play_mode }, data: data.rts as never });
      }
      this.processEEWData((data.eew as EewData[]) || []);
    }

    if (data.intensity) this.processIntensityData(data.intensity as never[]);
    if (data.lpgm) this.processLpgmData(data.lpgm as never[]);
    if (data.rts) variable.cache.last_data_time = localNow;
  }

  private startSSE() {
    if (variable.play_mode !== 0) return;
    this.sseActive = true;
    if (this.sseManager) return;

    const norm = (v: unknown): unknown => {
      if (v instanceof Uint8Array) {
        try {
          return JSON.parse(new TextDecoder().decode(v));
        } catch {
          return null;
        }
      }
      return v;
    };

    this.sseManager = sseInit({
      reconnectDelay: 3000,
      onRts: (raw) => {
        if (variable.play_mode !== 0) return;
        const value = norm(raw);
        if (value == null) return;
        this.sseHandled = true;
        variable.data.rts = value as never;
        events.emit("DataRts", { info: { type: variable.play_mode }, data: (value || {}) as never });
        variable.cache.last_data_time = Date.now();
      },
      onEew: (raw) => {
        if (variable.play_mode !== 0) return;
        const value = norm(raw);
        if (value == null) return;
        this.sseHandled = true;
        this.processEEWData(value as EewData[]);
      },
      onIntensity: (raw) => {
        if (variable.play_mode !== 0) return;
        const value = norm(raw);
        if (value == null) return;
        this.sseHandled = true;
        this.processIntensityData(value as never[]);
      },
      onLpgm: (raw) => {
        if (variable.play_mode !== 0) return;
        const value = norm(raw);
        if (value == null) return;
        this.sseHandled = true;
        this.processLpgmData(value as never[]);
      },
    });
  }

  private stopSSE() {
    this.sseActive = false;
    if (this.sseManager) {
      this.sseManager.abort();
      this.sseManager = null;
    }
    this.sseHandled = false;
  }

  /** Prevent live/replay domain objects and alert caches crossing a mode boundary. */
  private clearDomainState(mode: number): void {
    const eew = [...variable.data.eew];
    const intensity = [...variable.data.intensity] as { IntensityEnd?: number }[];
    const lpgm = [...variable.data.lpgm] as { LpgmEnd?: boolean }[];

    variable.data.rts = null;
    variable.data.eew = [];
    variable.data.intensity = [];
    variable.data.lpgm = [];

    variable.cache.rts_alert = false;
    variable.cache.unstable = 0;
    variable.cache.show_eew_box = false;
    variable.cache.rts_trigger = { max: 0, loc: [] };
    variable.cache.int_cache_list = {};
    variable.cache.eew_last = {};
    variable.cache.intensity_last = {};
    variable.cache.eewIntensityArea = {};
    variable.cache.show_intensity = false;
    variable.cache.show_lpgm = false;
    variable.cache.intensity = { time: 0, max: 0 };
    variable.cache.last_data_time = 0;
    variable.cache.last_rts_alert = 0;
    variable.cache.bounds.rts = [];
    variable.cache.bounds.intensity = [];
    variable.cache.bounds.lpgm = [];
    variable.cache.audio = {
      shindo: -1,
      pga: -1,
      status: { shindo: 0, pga: 0 },
      count: { pga_1: 0, pga_2: 0, shindo_1: 0, shindo_2: 0 },
    };

    ui.currentEew = null;
    ui.currentTrigger = null;
    events.emit("EewDisplayUpdate");

    eew.forEach((data) =>
      events.emit("EewEnd", { info: { type: mode }, data: { ...data, EewEnd: true } }),
    );
    intensity.forEach((data) =>
      events.emit("IntensityEnd", {
        info: { type: mode },
        data: { ...data, IntensityEnd: 1 },
      }),
    );
    lpgm.forEach((data) =>
      events.emit("LpgmEnd", { info: { type: mode }, data: { ...data, LpgmEnd: true } }),
    );
    events.emit("DataModeReset");
    events.emit("DataRts", { info: { type: mode }, data: null });
    events.emit("DataEew", { info: { type: mode }, data: [] as never });
    events.emit("DataIntensity", { info: { type: mode }, data: [] as never });
    events.emit("DataLpgm", { info: { type: mode }, data: [] as never });
  }

  /** Fully reset the live transport before entering or leaving replay. */
  resetTransport(): void {
    this.transportEpoch++;
    abortAll();
    this.stopSSE();
    this.lastFetchTime = 0;
  }

  processEEWData(newData: EewData[] = []): void {
    const currentTime = now();
    const EXPIRY_TIME = 240 * 1000;
    const STATUS_3_TIMEOUT = 60 * 1000;
    const eewList = variable.data.eew;

    type EewItem = EewData & { EewEnd?: boolean; status3Time?: number };
    const list = eewList as EewItem[];

    list
      .filter(
        (item) =>
          item.eq?.time &&
          (currentTime - item.eq.time > EXPIRY_TIME ||
            item.EewEnd ||
            (item.status === 3 && currentTime - (item.status3Time ?? 0) > STATUS_3_TIMEOUT)),
      )
      .forEach((data) => {
        events.emit("EewEnd", { info: { type: variable.play_mode }, data: { ...data, EewEnd: true } });
      });

    variable.data.eew = list.filter(
      (item) =>
        item.eq?.time &&
        currentTime - item.eq.time <= EXPIRY_TIME &&
        !item.EewEnd &&
        !(item.status === 3 && currentTime - (item.status3Time ?? 0) > STATUS_3_TIMEOUT),
    );

    Array.from(newData || []).forEach((data: EewItem) => {
      if (!data.eq?.time || currentTime - data.eq.time > EXPIRY_TIME || data.EewEnd) return;

      const cur = variable.data.eew as EewItem[];
      const existingIndex = cur.findIndex((item) => item.id == data.id);
      const eventData = { info: { type: variable.play_mode }, data };
      const eewLast = variable.cache.eew_last as Record<string, { last_time: number; serial: number }>;

      if (existingIndex == -1) {
        if (!eewLast[data.id]) {
          if ((EEW_AUTHOR as readonly string[]).includes(data.author)) {
            eewLast[data.id] = { last_time: currentTime, serial: 1 };
            const method = data.author === "trem" ? "nsspe" : "eew";
            cur.push({ ...data, method });
            events.emit("EewRelease", eventData);
          }
          return;
        }
      }

      if (eewLast[data.id] && eewLast[data.id].serial < data.serial) {
        eewLast[data.id].serial = data.serial;
        if (data.status === 3) data.status3Time = currentTime;
        events.emit("EewUpdate", eventData);
        if (data.eq.mag && data.eq.mag != 1) data.method = "eew";
        if (data.status == 3 && cur[existingIndex].status != data.status) {
          events.emit("EewCancel", eventData);
        }
        if (cur[existingIndex].status != 1 && data.status == 1) {
          events.emit("EewAlert", eventData);
        }
        cur[existingIndex] = data;
      }
    });

    this.cleanupCache("eew_last");
    events.emit("DataEew", { info: { type: variable.play_mode }, data: variable.data.eew as never });
  }

  private isAreaDifferent(
    area1?: Record<string, number[]>,
    area2?: Record<string, number[]>,
  ): boolean {
    if (!area1 || !area2) return true;
    const keys1 = Object.keys(area1);
    const keys2 = Object.keys(area2);
    if (keys1.length !== keys2.length) return true;
    return keys1.some((key) => {
      const a1 = area1[key] || [];
      const a2 = area2[key] || [];
      if (a1.length !== a2.length) return true;
      return !a1.every((v) => a2.includes(v));
    });
  }

  processIntensityData(newData: unknown[] = []): void {
    const currentTime = now();
    const EXPIRY_TIME = 600 * 1000;
    type IntItem = { id: number; serial: number; area?: Record<string, number[]>; IntensityEnd?: boolean };
    const list = variable.data.intensity as IntItem[];

    list
      .filter((item) => item.id && (currentTime - item.id > EXPIRY_TIME || item.IntensityEnd))
      .forEach((data) => {
        events.emit("IntensityEnd", { info: { type: variable.play_mode }, data: { ...data, IntensityEnd: true } });
      });

    variable.data.intensity = list.filter(
      (item) => item.id && currentTime - item.id <= EXPIRY_TIME && !item.IntensityEnd,
    );

    Array.from((newData as IntItem[]) || []).forEach((data) => {
      if (!data.id || currentTime - data.id > EXPIRY_TIME || data.IntensityEnd) return;
      const cur = variable.data.intensity as IntItem[];
      const existingIndex = cur.findIndex((item) => item.id == data.id);
      const eventData = { info: { type: variable.play_mode }, data };
      const last = variable.cache.intensity_last as Record<string, { last_time: number; serial: number }>;

      if (existingIndex == -1) {
        if (!last[data.id]) {
          last[data.id] = { last_time: currentTime, serial: 1 };
          cur.push(data);
          events.emit("IntensityRelease", eventData as never);
          return;
        }
      }

      if (last[data.id] && last[data.id].serial < data.serial) {
        last[data.id].serial = data.serial;
        if (this.isAreaDifferent(data.area, cur[existingIndex].area)) {
          events.emit("IntensityUpdate", eventData as never);
          cur[existingIndex] = data;
        }
      }
    });

    this.cleanupCache("intensity_last");
    events.emit("DataIntensity", { info: { type: variable.play_mode }, data: variable.data.intensity as never });
  }

  processLpgmData(newData: unknown[] = []): void {
    const currentTime = now();
    const EXPIRY_TIME = 600 * 1000;
    type LpgmItem = { id: number; time: number; LpgmEnd?: boolean };
    const list = variable.data.lpgm as LpgmItem[];

    list
      .filter((item) => item.time && (currentTime - item.time > EXPIRY_TIME || item.LpgmEnd))
      .forEach((data) => {
        events.emit("LpgmEnd", { info: { type: variable.play_mode }, data: { ...data, LpgmEnd: true } });
      });

    variable.data.lpgm = list.filter(
      (item) => item.time && currentTime - item.time <= EXPIRY_TIME && !item.LpgmEnd,
    );

    Array.from((newData as LpgmItem[]) || []).forEach((data) => {
      if (!data.id || data.LpgmEnd) return;
      const cur = variable.data.lpgm as LpgmItem[];
      const existingIndex = cur.findIndex((item) => item.id == data.id);
      const eventData = { info: { type: variable.play_mode }, data };
      if (existingIndex == -1) {
        data.id = Number(data.id);
        data.time = now();
        cur.push(data);
        events.emit("LpgmRelease", eventData as never);
      }
    });

    events.emit("DataLpgm", { info: { type: variable.play_mode }, data: variable.data.lpgm as never });
  }

  private cleanupCache(cacheKey: "eew_last" | "intensity_last"): void {
    const currentTime = now();
    const cache = variable.cache[cacheKey] as Record<string, { last_time: number }>;
    Object.keys(cache).forEach((id) => {
      if (currentTime - cache[id].last_time > 600000) delete cache[id];
    });
  }
}

let manager: DataManager | null = null;

/** Create the DataManager (idempotent). Wires MapLoad → 100ms fetch loop. */
export function initData(): DataManager {
  if (!manager) manager = new DataManager();
  return manager;
}

/** Drop live transport state so the next data loop follows the new play mode. */
export function resetDataTransport(): void {
  manager?.resetTransport();
}
