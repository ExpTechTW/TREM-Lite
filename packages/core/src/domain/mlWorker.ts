/**
 * The web's intensity model, off the main thread: building it walks ~420k tree
 * nodes, and each EEW update runs 368 towns through 2,800 trees.
 *
 *   in   { type: "model", bytes, towns }   the verified .onnx, and every town
 *        { type: "area", id, lat, lon, depth, mag }
 *   out  { type: "ready" } | { type: "failed", error }
 *        { type: "area", id, area?, error? }
 */
import { features, level, loadModel, N_FEAT, predict, type Model } from "./mlIntensity";

export interface Town {
  code: number;
  lat: number;
  lon: number;
}

export type AreaRequest = { type: "area"; id: number; lat: number; lon: number; depth: number; mag: number };

let model: Model | null = null;
let towns: Town[] = [];

/**
 * Great-circle distance (km) by the spherical law of cosines, then the depth:
 * the hypocentral distance, as math.rs gives it.
 */
function hypocentral(lat: number, lon: number, depth: number, t: Town): number {
  const d2r = Math.PI / 180;
  const la = lat * d2r;
  const lb = t.lat * d2r;
  const surface =
    Math.acos(Math.sin(la) * Math.sin(lb) + Math.cos(la) * Math.cos(lb) * Math.cos(lon * d2r - t.lon * d2r)) *
    6371.008;
  return Math.sqrt(surface * surface + depth * depth);
}

function area({ lat, lon, depth, mag }: AreaRequest): Record<number, { dist: number; level: number }> {
  if (!model) throw new Error("the intensity model is not ready");
  // The trees need finite features: a garbled report fails rather than paint
  // a plausible-looking map.
  if (![lat, lon, depth, mag].every(Number.isFinite)) throw new Error(`non-finite EEW M${mag} ${depth}km`);
  const rows = new Float32Array(towns.length * N_FEAT);
  towns.forEach((t, i) => features(rows, i * N_FEAT, mag, depth, lat, lon, t.lat, t.lon));
  const { pga, pgv } = predict(model, rows, towns.length);
  const out: Record<number, { dist: number; level: number }> = {};
  towns.forEach((t, i) => {
    out[t.code] = { dist: hypocentral(lat, lon, depth, t), level: level(pga[i], pgv[i]) };
  });
  return out;
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as { type: "model"; bytes: ArrayBuffer; towns: Town[] } | AreaRequest;
  if (msg.type === "model") {
    try {
      model = loadModel(new Uint8Array(msg.bytes));
      towns = msg.towns;
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "failed", error: String(err) });
    }
    return;
  }
  try {
    self.postMessage({ type: "area", id: msg.id, area: area(msg) });
  } catch (err) {
    self.postMessage({ type: "area", id: msg.id, error: String(err) });
  }
};
