/**
 * Shared helpers — ported from legacy/src/js/index/utils/utils.js.
 * Pure functions + a couple of browser (Image/SVG) helpers used for map sprites.
 */
import { COLOR } from "@/lib/constants";

import { region } from "./region";

/** Curried haversine distance (km). */
export function distance(latA: number, lngA: number) {
  return function (latB: number, lngB: number): number {
    latA = (latA * Math.PI) / 180;
    lngA = (lngA * Math.PI) / 180;
    latB = (latB * Math.PI) / 180;
    lngB = (lngB * Math.PI) / 180;
    const sin_latA = Math.sin(Math.atan(Math.tan(latA)));
    const sin_latB = Math.sin(Math.atan(Math.tan(latB)));
    const cos_latA = Math.cos(Math.atan(Math.tan(latA)));
    const cos_latB = Math.cos(Math.atan(Math.tan(latB)));
    return (
      Math.acos(sin_latA * sin_latB + cos_latA * cos_latB * Math.cos(lngA - lngB)) *
      6371.008
    );
  };
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

export function search_loc_name(int: number): { city: string; town: string } | null {
  for (const city of Object.keys(region)) {
    for (const town of Object.keys(region[city])) {
      if (region[city][town].code == int) {
        return { city, town };
      }
    }
  }
  return null;
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
        font-family="Maple Mono NF CN, sans-serif">${intensity}</text>
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
        font-family="Maple Mono NF CN, sans-serif">${intensity}</text>
    </svg>
  `);
}

type MatchExpression = (string | number | string[])[];

/** Build a MapLibre `match` expression coloring towns by intensity/lpgm. */
export function generateMapStyle(
  eewArea: Record<string, number>,
  end = false,
  lpgm = false,
): string | MatchExpression {
  if (end) {
    return COLOR.MAP.TW_COUNTY_FILL;
  }

  const matchExpression: MatchExpression = ["match", ["get", "CODE"]];

  if (Object.keys(eewArea).length > 0) {
    Object.entries(eewArea).forEach(([code, intensity]) => {
      matchExpression.push(parseInt(code));
      matchExpression.push(
        intensity
          ? lpgm
            ? COLOR.LPGM[intensity]
            : COLOR.INTENSITY[intensity]
          : COLOR.MAP.TW_COUNTY_FILL,
      );
    });
  }

  matchExpression.push(COLOR.MAP.TW_TOWN_FILL);

  return matchExpression;
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
