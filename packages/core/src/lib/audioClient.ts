/**
 * Audio wiring — subscribes to domain events and forwards them to the Rust
 * audio engine (see src-tauri/src/audio.rs). Ported from the routing logic of
 * legacy/src/js/index/core/audio.js. On desktop all playback happens in Rust,
 * with the queue/priority/volume rules; on the web, webAudio.ts plays the same
 * clips by the same rules. Speech is handled separately by speechClient so
 * effects and speech keep independent queues.
 */
import { invoke } from "@tauri-apps/api/core";

import { AUDIO } from "./constants";
import { getConfig } from "./config";
import { events } from "./events";
import { inTauri } from "./env";
import { createLogger } from "./logger";
import { webAudio, type QueueName } from "./webAudio";

const log = createLogger("audio");

export function enqueue(queue: QueueName, sound: string): void {
  log.info(`音效排入 ${queue} 佇列：${sound}`);
  if (!inTauri) return webAudio.enqueue(queue, sound);
  void invoke("audio_enqueue", { queue, sound });
}
export function play(sound: string): void {
  log.info(`播放音效：${sound}`);
  if (!inTauri) return webAudio.play(sound);
  void invoke("audio_play", { sound });
}
export function clearQueue(queue: QueueName): void {
  log.debug(`清空 ${queue} 佇列裡還沒播的音效`);
  if (!inTauri) return webAudio.clear(queue);
  void invoke("audio_clear", { queue });
}

/** Play a clip once for the settings page, cutting off the previous preview. */
export function preview(sound: string): void {
  log.info(`試聽音效：${sound}`);
  if (!inTauri) return webAudio.preview(sound);
  void invoke("audio_preview", { sound });
}

/** Silence everything playing or queued — at a live/replay boundary. */
export function stopAll(): void {
  log.info("停止所有音效（播放中與排隊中的）");
  if (!inTauri) return webAudio.stopAll();
  void invoke("audio_stop_all");
}
function sfx(key: string): boolean {
  try {
    const on = !!getConfig()["check-box"][key];
    if (!on) log.debug(`音效設定 ${key} 關閉，這次不播`);
    return on;
  } catch {
    return false;
  }
}

let bound = false;

/** Subscribe the audio engine to the event bus. Call once at startup. */
export function initAudio(): void {
  if (bound) return;
  bound = true;

  events.on("EewRelease", ({ data }) => {
    if (data.status == 1) {
      if (sfx("sound-effects-EEW2")) enqueue("eew", AUDIO.ALERT);
    } else {
      if (sfx("sound-effects-EEW")) enqueue("eew", AUDIO.EEW);
    }
  });

  events.on("EewAlert", () => {
    if (sfx("sound-effects-EEW2")) enqueue("eew", AUDIO.ALERT);
  });

  events.on("EewUpdate", () => {
    clearQueue("update");
    if (sfx("sound-effects-Update")) enqueue("update", AUDIO.UPDATE);
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
