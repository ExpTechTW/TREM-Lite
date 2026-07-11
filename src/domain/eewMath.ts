/**
 * EEW intensity attenuation — delegated to Rust (see src-tauri/src/math.rs) for
 * speed. Equivalent to EEWCalculator.eewAreaPga but runs the ~370-town loop
 * natively. Kept here as a thin typed wrapper so callers stay clean.
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
