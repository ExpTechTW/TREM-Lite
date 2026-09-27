/**
 * Shared helpers — ported from legacy/src/js/index/utils/utils.js.
 * Pure functions + a couple of browser (Image/SVG) helpers used for map sprites.
 */
import { COLOR } from "@/lib/constants";

import { region } from "./region";

/**
 * Great-circle distance (km) by the spherical law of cosines.
 *
 * Legacy took each latitude's sine and cosine through `atan(tan(x))`, which is
 * x itself for any latitude (|x| < 90°): four tangents and four arctangents on
 * every call, for nothing. Over every pair of towns, 99.3% of distances come
 * out identical without them; the rest differ by rounding, at most 9.5 cm, and
 * only for two points in the same place — where the arccosine's argument is 1
 * and the formula's own noise is that large either way. The callers only ever
 * compare a distance with another or with 50 km, and no comparison changes.
 *
 * The cosine is capped at 1: for two points in the same place it can round to
 * just above, and the arccosine of that is NaN — which the nearest-station
 * searches then skip, choosing a station farther away. Capped, it is 0.
 */
export function distance(latA: number, lngA: number, latB: number, lngB: number): number {
  const radLatA = (latA * Math.PI) / 180;
  const radLatB = (latB * Math.PI) / 180;
  const dLng = (lngA * Math.PI) / 180 - (lngB * Math.PI) / 180;
  const cos = Math.sin(radLatA) * Math.sin(radLatB) + Math.cos(radLatA) * Math.cos(radLatB) * Math.cos(dLng);
  return Math.acos(Math.min(1, cos)) * 6371.008;
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/** Town code → its city and town, built the first time region.bin is ready. */
let townsByCode: Map<number, { city: string; town: string }> | null = null;

/**
 * The city and town a code belongs to, or null.
 *
 * This walked all 368 towns on every call — several times per RTS frame, and
 * once per town when an intensity report arrives. The index keeps the first
 * town for a code, as the scan did, and a fresh object is returned each time,
 * as before.
 */
export function search_loc_name(int: number): { city: string; town: string } | null {
  if (!townsByCode) {
    const cities = Object.keys(region);
    // region.bin not decoded yet: the scan found nothing either. Not cached,
    // so the index is built from the real table once it arrives.
    if (!cities.length) return null;
    townsByCode = new Map();
    for (const city of cities) {
      for (const town of Object.keys(region[city])) {
        const code = region[city][town].code;
        if (!townsByCode.has(code)) townsByCode.set(code, { city, town });
      }
    }
  }
  const hit = townsByCode.get(Number(int));
  return hit ? { city: hit.city, town: hit.town } : null;
}

/** Report-list timestamp — `YYYY-MM-DD HH:MM` (NO seconds), per legacy report.js. */
export function formatReportTime(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

export function formatTimestamp(Timestamp: number, offsetMs = 0): string {
  const date = new Date(Timestamp + offsetMs);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function intensity_float_to_int(float: number): number {
  return float < 0
    ? 0
    : float < 4.5
      ? Math.round(float)
      : float < 5
        ? 5
        : float < 5.5
          ? 6
          : float < 6
            ? 7
            : float < 6.5
              ? 8
              : 9;
}

export function int_to_string(max: number): string {
  return max == 5
    ? "5弱"
    : max == 6
      ? "5強"
      : max == 7
        ? "6弱"
        : max == 8
          ? "6強"
          : max == 9
            ? "7級"
            : `${max}級`;
}

export function extractLocation(loc: string): string {
  const match = loc.match(/位於(.+)(?=\))/);
  let extracted = match ? match[1] : loc;
  const spaceIndex = extracted.indexOf(" ");
  if (spaceIndex !== -1) {
    extracted = extracted.substring(0, spaceIndex);
  }
  return extracted;
}

/** Build an <img> from an inline SVG (used as a MapLibre sprite image). */
function svgImage(svg: string): HTMLImageElement {
  const img = new Image();
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  return img;
}

export function createIntensityIconSquare(
  intensity: string | number,
  backgroundColor: string,
  textColor: string,
  strokeColor: string,
): HTMLImageElement {
  return svgImage(`
    <svg width="60" height="60" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="2" width="56" height="56" rx="10" ry="10"
        fill="${backgroundColor}" stroke="${strokeColor}" stroke-width="3" />
      <text x="30" y="35" font-size="36" font-weight="bold" fill="${textColor}"
        text-anchor="middle" dominant-baseline="middle"
        font-family="Manrope, Noto Sans TC, sans-serif">${intensity}</text>
    </svg>
  `);
}

export function createIntensityIcon(
  intensity: string | number,
  backgroundColor: string,
  textColor: string,
  strokeColor: string,
): HTMLImageElement {
  return svgImage(`
    <svg width="60" height="60" xmlns="http://www.w3.org/2000/svg">
      <circle cx="30" cy="30" r="28"
        fill="${backgroundColor}" stroke="${strokeColor}" stroke-width="3" />
      <text x="30" y="35" font-size="36" font-weight="bold" fill="${textColor}"
        text-anchor="middle" dominant-baseline="middle"
        font-family="Manrope, Noto Sans TC, sans-serif">${intensity}</text>
    </svg>
  `);
}

/** Each town's colour for its level: intensity's or long-period's palette, 0 unlit. */
export function townColors(area: Record<string, number>, lpgm = false): Record<number, string> {
  const colors: Record<number, string> = {};
  for (const [code, level] of Object.entries(area)) {
    colors[parseInt(code)] = level ? (lpgm ? COLOR.LPGM[level] : COLOR.INTENSITY[level]) : COLOR.MAP.TW_COUNTY_FILL;
  }
  return colors;
}

export function convertIntensityToAreaFormat(
  intensityData: Record<string, number[]>,
): Record<number, number> {
  const result: Record<number, number> = {};
  Object.entries(intensityData).forEach(([intensity, codes]) => {
    codes.forEach((code) => {
      result[code] = parseInt(intensity);
    });
  });
  return result;
}
