/** Typed accessor for the bundled Taiwan region lookup table. */
import regionJson from "@/data/region.json";

export interface RegionInfo {
  code: number;
  lat: number;
  lon: number;
  site?: number;
  area?: string;
}

export type Region = Record<string, Record<string, RegionInfo>>;

export const region = regionJson as unknown as Region;
