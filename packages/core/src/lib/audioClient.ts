/**
 * Audio wiring — subscribes to domain events and forwards them to the Rust
 * audio engine (see src-tauri/src/audio.rs). Ported from the routing logic of
 * legacy/src/js/index/core/audio.js. All actual playback happens in Rust; the
 * queue/priority/volume rules also live there. Speech is handled separately by
 * speechClient so native effects and system TTS retain independent queues.
 */
import { invoke } from "@tauri-apps/api/core";

import { AUDIO, SHOW_TREM_EEW } from "./constants";
import { getConfig } from "./config";
import { events } from "./events";
import { inTauri } from "./env";

type QueueName = "eew" | "pga" | "shindo" | "update";

export function enqueue(queue: QueueName, sound: string): void {
  if (!inTauri) return;
  void invoke("audio_enqueue", { queue, sound });
}
export function play(sound: string): void {
  if (!inTauri) return;
  void invoke("audio_play", { sound });
}
export function clearQueue(queue: QueueName): void {
  if (!inTauri) return;
  void invoke("audio_clear", { queue });
}
function sfx(key: string): boolean {
  try {
    return !!getConfig()["check-box"][key];
  } catch {
    return false;
  }
}

/** True when a TREM-authored EEW should be suppressed. */
function suppressedTrem(author: string | undefined): boolean {
  return !SHOW_TREM_EEW && author === "trem";
}

let bound = false;

/** Subscribe the audio engine to the event bus. Call once at startup. */
export function initAudio(): void {
  if (bound) return;
  bound = true;

  events.on("EewRelease", ({ data }) => {
    if (suppressedTrem(data.author)) return;
    if (data.status == 1) {
      if (sfx("sound-effects-EEW2")) enqueue("eew", AUDIO.ALERT);
    } else {
      if (sfx("sound-effects-EEW")) enqueue("eew", AUDIO.EEW);
    }
  });

  events.on("EewAlert", ({ data }) => {
    if (suppressedTrem(data.author)) return;
    if (sfx("sound-effects-EEW2")) enqueue("eew", AUDIO.ALERT);
  });

  events.on("EewUpdate", ({ data }) => {
    if (suppressedTrem(data.author)) return;
    clearQueue("update");
    if (sfx("sound-effects-Update")) enqueue("update", AUDIO.UPDATE);
  });

  // CANCEL always plays (no config gate), via the eew queue.
  events.on("EewCancel", () => {
    enqueue("eew", AUDIO.CANCEL);
  });

  events.on("RtsPga2", () => {
    if (sfx("sound-effects-PGA2")) enqueue("pga", AUDIO.PGA2);
  });
  events.on("RtsPga1", () => {
    if (sfx("sound-effects-PGA1")) enqueue("pga", AUDIO.PGA1);
  });

  events.on("RtsShindo2", () => {
    if (sfx("sound-effects-Shindo2")) enqueue("shindo", AUDIO.SHINDO2);
  });
  events.on("RtsShindo1", () => {
    if (sfx("sound-effects-Shindo1")) enqueue("shindo", AUDIO.SHINDO1);
  });
  events.on("RtsShindo0", () => {
    if (sfx("sound-effects-Shindo0")) enqueue("shindo", AUDIO.SHINDO0);
  });

  events.on("ReportRelease", () => {
    if (sfx("sound-effects-Report")) play(AUDIO.REPORT);
  });

  events.on("LpgmRelease", () => {
    if (sfx("sound-effects-PAlert")) play(AUDIO.INTENSITY);
  });
  events.on("IntensityRelease", () => {
    if (sfx("sound-effects-PAlert")) play(AUDIO.INTENSITY);
  });
  events.on("IntensityUpdate", () => {
    if (sfx("sound-effects-PAlert")) play(AUDIO.INTENSITY);
  });

  // TSUNAMI always plays.
  events.on("TsunamiRelease", () => {
    play(AUDIO.TSUNAMI);
  });
}
