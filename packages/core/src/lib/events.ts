/**
 * Central event bus — replaces the Node `EventEmitter` at
 * `TREM.variable.events` in the Electron app. Same event names, typed payloads.
 */
import mitt, { type Emitter } from "mitt";

import type { TremEvents } from "./types";

export const events: Emitter<TremEvents> = mitt<TremEvents>();

export type { TremEvents };
