/**
 * The realtime station dots' colours, identical to rts-image-go's station
 * layer (ExpTechTW/rts-image-go, internal/drawer IntColor over
 * resource/color.json).
 *
 * Two steps, as there:
 *
 *   1. The measured intensity `i` is moved onto the colour table's own scale,
 *      which runs from −3 to 7 with green at 0:
 *        i ≤ 0      → −3            (the darkest blue)
 *        0 < i ≤ 1  → −3 … 0        (blue → green)
 *        i > 1      → 0 … 7         (green at 1 → dark red at 7)
 *   2. That value is looked up in 0.1 steps (rounded half away from zero, as
 *      Go's math.Round does) and clamped to the table.
 *
 * The table below is color.json, one entry per 0.1 from −3.0 to 7.0.
 */
import type { ExpressionSpecification } from "maplibre-gl";

export const RTS_PALETTE: readonly string[] = [
  "#0000cd", "#0007d1", "#000ed6", "#0015da", "#001cdf", "#0024e3", "#002be7", "#0032ec",
  "#0039f0", "#0040f5", "#0048fa", "#0055ee", "#0063e3", "#0070d8", "#007ecd", "#008cc2",
  "#0099b7", "#00a7ac", "#00b4a1", "#00c296", "#00d08b", "#06d482", "#0cd879", "#12dc71",
  "#19e068", "#1fe460", "#25e958", "#2ced4f", "#32f147", "#38f53e", "#3ffa36", "#4bfa31",
  "#58fa2d", "#64fb29", "#71fb25", "#7dfc21", "#8afc1c", "#97fd18", "#a3fd14", "#b0fe10",
  "#bdff0c", "#c3fe0a", "#cafe09", "#d0fe08", "#d7fe07", "#deff05", "#e4fe04", "#ebff03",
  "#f1fe02", "#f8ff01", "#ffff00", "#fefb00", "#fef800", "#fef400", "#fef100", "#ffee00",
  "#feea00", "#ffe700", "#fee300", "#ffe000", "#ffdd00", "#fed500", "#fecd00", "#fec500",
  "#febe00", "#ffb600", "#feae00", "#ffa700", "#fe9f00", "#ff9700", "#ff9000", "#fe8800",
  "#fe8000", "#fe7900", "#fe7100", "#ff6a00", "#fe6200", "#ff5a00", "#fe5300", "#ff4b00",
  "#ff4400", "#fe3d00", "#fd3600", "#fc2f00", "#fb2800", "#fa2100", "#f91b00", "#f81400",
  "#f70d00", "#f60600", "#f50000", "#ee0000", "#e60000", "#df0000", "#d70000", "#d00000",
  "#c80000", "#c00000", "#b90000", "#b10000", "#aa0000",
];

/** `circle-color` for a layer whose features carry the intensity as `i`. */
export function rtsColor(): ExpressionSpecification {
  const i = ["get", "i"];
  const scale = [
    "case",
    ["<=", i, 0], -3,
    ["<=", i, 1], ["+", -3, ["*", 3, i]],
    ["/", ["*", 7, ["-", i, 1]], 6],
  ];
  // Integer tenths, so every stop compares exactly.
  const tenth = ["round", ["*", scale, 10]];
  const stops = RTS_PALETTE.slice(1).flatMap((color, n) => [n - 29, color]);
  return ["step", tenth, RTS_PALETTE[0], ...stops] as unknown as ExpressionSpecification;
}
