import type { CSSProperties } from "react";

import { useRerenderOn } from "@/hooks/useTremEvent";
import { INTENSITY_LIST } from "@/lib/constants";
import { variable } from "@/lib/variable";

import "./intensity-legend.css";

/** Full scale: indices 1..9 are 1, 2, 3, 4, 5⁻, 5⁺, 6⁻, 6⁺, 7. */
const LEGEND_FULL = INTENSITY_LIST.length - 1;

/**
 * Highest step to draw. The full scale unless an EEW wash is on the map.
 *
 * Each warning stores `max_i`, the strongest level that wash paints — the
 * model's, raised where the warning's own area is stronger — and the scale
 * stops at the highest of those, so a colour on the map always has a row.
 * A measured report or long-period overlay paints every step and gets the
 * full scale back; so does a warning that paints nothing felt.
 */
function legendCeiling(): number {
  if (variable.cache.show_intensity || variable.cache.show_lpgm) return LEGEND_FULL;
  let highest = 0;
  for (const area of Object.values(variable.cache.eewIntensityArea)) {
    if (!area || typeof area !== "object" || !("max_i" in area)) continue;
    const max = (area as { max_i?: unknown }).max_i;
    if (typeof max !== "number" || !Number.isFinite(max)) continue;
    const level = Math.min(LEGEND_FULL, Math.max(0, Math.round(max)));
    if (level > highest) highest = level;
  }
  return highest >= 1 ? highest : LEGEND_FULL;
}

/** Left-side vertical intensity color scale (ports the intensity-color-list). */
export function IntensityLegend() {
  useRerenderOn(
    "EewAreaPaint",
    "IntensityRelease",
    "IntensityUpdate",
    "LpgmRelease",
    "DataModeReset",
  );
  const ceiling = legendCeiling();

  return (
    <div className="legacy-intensity-legend pointer-events-none absolute bottom-10 left-0 z-10 flex w-[45px] flex-col items-end">
      {/* column-reverse: intensity 1 at the bottom, level 7 at the top.
          During an EEW the top stops at the strongest painted level. */}
      <ul
        className="legacy-intensity-legend-list flex flex-col-reverse"
        style={{ "--legend-steps": String(ceiling) } as CSSProperties}
      >
        {INTENSITY_LIST.map((label, i) =>
          i === 0 || i > ceiling ? null : (
            <li
              key={i}
              className="relative flex h-full items-start ml-[30px] pl-[18px] text-[13px]"
              style={{ color: "#ffffff91" }}
            >
              {/* continuous vertical gradient strip */}
              <span
                className="absolute left-[-10px] top-[8px] box-content h-full w-[10px]"
                style={{
                  background: `linear-gradient(var(--intensity-${i}), var(--intensity-${i - 1}))`,
                  borderLeft: "1px solid #2b2b2b",
                  borderRight: "1px solid #2b2b2b",
                  borderTop: i === ceiling ? "1px solid #2b2b2b" : undefined,
                  borderBottom: i === 1 ? "1px solid #2b2b2b" : undefined,
                }}
              >
                {/* boundary tick mark (.color::after) */}
                <span
                  className="absolute top-0 right-[-6px] h-px w-[5px]"
                  style={{ backgroundColor: "#ffffff91" }}
                />
              </span>
              {label}
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
