/**
 * EEW predicted intensity per town, from the ML model v1
 * (intensity_ml_v1.onnx).
 *
 * On desktop it runs in Rust (src-tauri/src/math.rs, ml_intensity.rs), which
 * downloads the model on first launch. On the web it runs in a worker
 * (mlWorker.ts, mlIntensity.ts — the same evaluator, to the bit): the model
 * comes from the web build itself (packages/core/static/models), is checked
 * against its SHA-256 and kept in Cache Storage, so it is downloaded once.
 */
import { invoke } from "@tauri-apps/api/core";

import { region, regionReady } from "@/domain/region";
import { inTauri } from "@/lib/env";
import { http } from "@/lib/http";
import { createLogger } from "@/lib/logger";

import { MODEL_SHA256 } from "./mlIntensity";
import type { Town } from "./mlWorker";

export interface EewAreaEntry {
  /** Hypocentral distance (km). */
  dist: number;
  /** Predicted CWA level 0-9 (5 = 5弱 … 9 = 7). */
  level: number;
}

export interface EewArea {
  /** town code -> { dist, level } */
  area: Record<number, EewAreaEntry>;
}

export function eewAreaIntensity(lat: number, lon: number, depth: number, mag: number): Promise<EewArea> {
  if (inTauri) return invoke<EewArea>("eew_area_intensity", { lat, lon, depth, mag });
  return webArea(lat, lon, depth, mag);
}

// ─── Web ─────────────────────────────────────────────────────────────────────

const log = createLogger("ml");
const MODEL_URL = `${import.meta.env.BASE_URL}models/intensity_ml_v1.onnx`;
const CACHE = "trem-models";
/** How long to wait before trying the download again. */
const RETRY_MS = 60_000;

let ready: Promise<Worker> | null = null;
let nextId = 0;
const waiting = new Map<number, (reply: { area?: EewArea["area"]; error?: string }) => void>();
/** Successive reports often repeat the solution; the last answer is reused. */
let last: { key: string; result: EewArea } | null = null;

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The model's bytes: the kept copy if it is intact, else a fresh download, kept. */
async function modelBytes(): Promise<Uint8Array> {
  const cache = await caches.open(CACHE).catch(() => null);
  const kept = await cache?.match(MODEL_URL);
  if (kept) {
    const bytes = new Uint8Array(await kept.arrayBuffer());
    if ((await sha256(bytes)) === MODEL_SHA256) return bytes;
    await cache?.delete(MODEL_URL);
  }
  const bytes = await http.asset(MODEL_URL);
  if ((await sha256(bytes)) !== MODEL_SHA256) throw new Error("the downloaded model failed its SHA-256 check");
  await cache?.put(MODEL_URL, new Response(bytes.slice())).catch(() => {});
  return bytes;
}

async function start(): Promise<Worker> {
  const [bytes] = await Promise.all([modelBytes(), regionReady]);
  const towns: Town[] = Object.values(region).flatMap((city) => Object.values(city));
  const worker = new Worker(new URL("./mlWorker.ts", import.meta.url), { type: "module" });
  await new Promise<void>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; id?: number; area?: EewArea["area"]; error?: string };
      if (msg.type === "ready") resolve();
      else if (msg.type === "failed") reject(new Error(msg.error));
      else if (msg.type === "area" && msg.id !== undefined) {
        waiting.get(msg.id)?.(msg);
        waiting.delete(msg.id);
      }
    };
    const buffer = bytes.slice().buffer;
    worker.postMessage({ type: "model", bytes: buffer, towns }, [buffer]);
  });
  log.info("intensity model ready");
  return worker;
}

/**
 * Start fetching and building the model, if not already — at startup, so it
 * is ready before an EEW needs it. A failure (offline) is retried.
 */
export function prepareIntensityModel(): Promise<Worker> {
  ready ??= start().catch((err) => {
    log.warn("intensity model unavailable, retrying", err);
    ready = null;
    setTimeout(() => void prepareIntensityModel().catch(() => {}), RETRY_MS);
    throw err;
  });
  return ready;
}

async function webArea(lat: number, lon: number, depth: number, mag: number): Promise<EewArea> {
  const key = [lat, lon, depth, mag].join();
  if (last?.key === key) return last.result;
  const worker = await prepareIntensityModel();
  const id = nextId++;
  const reply = await new Promise<{ area?: EewArea["area"]; error?: string }>((resolve) => {
    waiting.set(id, resolve);
    worker.postMessage({ type: "area", id, lat, lon, depth, mag });
  });
  if (!reply.area) throw new Error(reply.error ?? "no area");
  const result = { area: reply.area };
  last = { key, result };
  return result;
}
