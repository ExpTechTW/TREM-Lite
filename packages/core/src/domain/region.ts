/** Typed accessor for the Taiwan region lookup table (from region.bin). */
import regionBinUrl from "@/data/region.bin?url";
import { decodeRegion } from "@/lib/bindata";
import { http } from "@/lib/http";

export interface RegionInfo {
  code: number;
  lat: number;
  lon: number;
}

export type Region = Record<string, Record<string, RegionInfo>>;

// Loaded async from the compact binary (kept out of the JS bundle). Starts empty
// and is filled in place, so existing `import { region }` consumers keep working;
// search_loc_name simply finds nothing for the few ms before it loads — well
// before the first RTS frame needs a station name. Await `regionReady` if needed.
export const region: Region = {};
export const regionReady: Promise<void> = http
  .asset(regionBinUrl)
  .then((buf) => {
    Object.assign(region, decodeRegion(buf));
  })
  .catch(() => {});
