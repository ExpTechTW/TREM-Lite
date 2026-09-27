/**
 * The detection-box polygons: drawn by box.ts during an alert, and used by the
 * rts.v1 reader to tell which box a triggered station stands in. Loaded async
 * from the compact binary, out of the JS bundle.
 */
import boxBinUrl from "@/data/box.bin?url";
import { type BoxFeature, decodeBox } from "@/lib/bindata";
import { http } from "@/lib/http";

let boxes: BoxFeature[] = [];
/** Station coordinates never move within a run, so each point is looked up once. */
const memo = new Map<string, number | null>();

void http
  .asset(boxBinUrl)
  .then((buf) => {
    boxes = decodeBox(buf).features;
    memo.clear();
  })
  .catch(() => {});

/** Every box polygon; empty until the binary has loaded. */
export function getBoxes(): BoxFeature[] {
  return boxes;
}

/** Even-odd ray cast against one ring. */
function inside(lon: number, lat: number, ring: number[][]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** The ID of the box a point lies in, or null — also null until loaded. */
export function boxOf(lon: number, lat: number): number | null {
  if (!boxes.length) return null;
  const key = `${lon},${lat}`;
  const known = memo.get(key);
  if (known !== undefined) return known;
  const box = boxes.find((b) => inside(lon, lat, b.geometry.coordinates[0]));
  const id = box ? box.properties.ID : null;
  memo.set(key, id);
  return id;
}
