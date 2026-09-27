/**
 * The web's sound effects: the desktop Rust engine's rules (src-tauri/src/
 * audio.rs), on the browser's Web Audio.
 *
 *   * 4 independent serial queues: `eew`, `pga`, `shindo`, `update`. Each
 *     plays one clip at a time, in order; different queues overlap.
 *   * A clip queued removes the lower-priority clips still waiting in its
 *     queue (`PREEMPTS`). Clips queued within BATCH_MS of each other are
 *     settled together before any starts, as the Rust engine batches them:
 *     SHINDO0, 1 and 2 from one RTS frame play SHINDO2 alone.
 *   * REPORT, INTENSITY and TSUNAMI bypass the queues and may overlap.
 *   * `ALERT` plays twice.
 *   * Per-clip volume: SHINDO0 0.4, UPDATE 0.2, everything else 1.0.
 *
 * A browser plays nothing until the page has been interacted with, so every
 * clip is silent until the welcome dialog's button (WebWelcome.tsx) calls
 * `unlock()`, which also decodes all twelve at once — an EEW's first sound
 * must not wait for a download. The clips are the desktop's own mp3s, which
 * the web build serves from packages/core/static.
 */
import { http } from "./http";

export type QueueName = "eew" | "pga" | "shindo" | "update";

const CLIPS = [
  "ALERT",
  "CANCEL",
  "EEW",
  "INTENSITY",
  "PGA1",
  "PGA2",
  "REPORT",
  "SHINDO0",
  "SHINDO1",
  "SHINDO2",
  "TSUNAMI",
  "UPDATE",
];

const VOLUME: Record<string, number> = { SHINDO0: 0.4, UPDATE: 0.2 };

const PREEMPTS: Record<string, string[]> = {
  PGA2: ["PGA1", "PGA0"],
  PGA1: ["PGA0"],
  SHINDO2: ["SHINDO1", "SHINDO0"],
  SHINDO1: ["SHINDO0"],
  ALERT: ["EEW"],
};

const BATCH_MS = 10;

interface Queue {
  /** Playing, or being started: nothing else may start meanwhile. */
  busy: boolean;
  playing: AudioBufferSourceNode | null;
  pending: string[];
  timer: ReturnType<typeof setTimeout> | null;
}

let ctx: AudioContext | null = null;
const decoded = new Map<string, Promise<AudioBuffer | null>>();
const queues = new Map<QueueName, Queue>();
/** Clips playing outside the queues, so stopAll reaches them too. */
const direct = new Set<AudioBufferSourceNode>();
/** The settings page's 試聽: one at a time, the next cutting the last off. */
let previewing: AudioBufferSourceNode | null = null;
/** Bumped by stopAll: a clip still being readied when it runs never plays. */
let epoch = 0;

function buffer(name: string): Promise<AudioBuffer | null> {
  let clip = decoded.get(name);
  if (!clip) {
    const audio = ctx;
    clip = audio
      ? http
          .asset(`${import.meta.env.BASE_URL}audio/${name}.mp3`)
          // decodeAudioData takes (and detaches) an ArrayBuffer of its own.
          .then((bytes) => audio.decodeAudioData(bytes.slice().buffer))
          .catch(() => null)
      : Promise.resolve(null);
    decoded.set(name, clip);
  }
  return clip;
}

/** Start a clip as soon as it is decoded. */
async function start(name: string): Promise<AudioBufferSourceNode | null> {
  const clip = await buffer(name);
  if (!ctx || !clip) return null;
  const source = ctx.createBufferSource();
  source.buffer = clip;
  const gain = ctx.createGain();
  gain.gain.value = VOLUME[name] ?? 1;
  source.connect(gain).connect(ctx.destination);
  source.start();
  return source;
}

function queue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) queues.set(name, (q = { busy: false, playing: null, pending: [], timer: null }));
  return q;
}

/** Start the queue's next clip if it is idle. */
async function pump(q: Queue): Promise<void> {
  if (q.busy) return;
  const next = q.pending.shift();
  if (!next) return;
  q.busy = true;
  const at = epoch;
  const source = await start(next);
  // stopAll ran meanwhile: it has reset this queue, which may already be
  // starting something newer.
  if (at !== epoch) return source?.stop();
  if (!source) {
    q.busy = false;
    return pump(q); // undecodable: on to the next
  }
  q.playing = source;
  source.onended = () => {
    if (q.playing !== source) return;
    q.playing = null;
    q.busy = false;
    void pump(q);
  };
}

export const webAudio = {
  /** Allow playback, and decode every clip. Must run inside a click. */
  unlock(): void {
    try {
      ctx ??= new AudioContext();
      void ctx.resume();
    } catch {
      return; // no Web Audio: effects stay silent
    }
    for (const name of CLIPS) void buffer(name);
  },

  enqueue(name: QueueName, sound: string): void {
    if (!ctx) return;
    const q = queue(name);
    const evict = PREEMPTS[sound];
    if (evict) q.pending = q.pending.filter((p) => !evict.includes(p));
    if (sound === "ALERT") q.pending.push(sound);
    q.pending.push(sound);
    q.timer ??= setTimeout(() => {
      q.timer = null;
      void pump(q);
    }, BATCH_MS);
  },

  play(sound: string): void {
    if (!ctx) return;
    const at = epoch;
    void start(sound).then((source) => {
      if (!source) return;
      if (at !== epoch) return source.stop();
      direct.add(source);
      source.onended = () => direct.delete(source);
    });
  },

  /** Play a clip for the settings page, stopping the previous preview. From a click. */
  preview(sound: string): void {
    webAudio.unlock();
    previewing?.stop();
    previewing = null;
    const at = epoch;
    void start(sound).then((source) => {
      if (!source) return;
      if (at !== epoch) return source.stop();
      previewing?.stop();
      previewing = source;
    });
  },

  /** Drop the clips waiting in a queue; the one playing finishes. */
  clear(name: QueueName): void {
    queue(name).pending = [];
  },

  stopAll(): void {
    epoch++;
    for (const q of queues.values()) {
      q.pending = [];
      const playing = q.playing;
      q.playing = null;
      q.busy = false;
      playing?.stop();
    }
    for (const source of direct) source.stop();
    direct.clear();
    previewing?.stop();
    previewing = null;
  },
};
