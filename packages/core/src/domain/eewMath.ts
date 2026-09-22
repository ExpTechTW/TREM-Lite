/**
 * EEW intensity attenuation — computed in Rust (src-tauri/src/math.rs), which
 * runs the ~370-town loop natively. This is the thin typed wrapper around it.
 */
import { invoke } from "@tauri-apps/api/core";

export interface EewAreaEntry {
  dist: number;
  i: number;
}

export interface EewArea {
  max_i: number;
  /** town code -> { dist, i } */
  area: Record<number, EewAreaEntry>;
}

export function eewAreaPga(
  lat: number,
  lon: number,
  depth: number,
  mag: number,
): Promise<EewArea> {
  return invoke<EewArea>("eew_area_pga", { lat, lon, depth, mag });
}
