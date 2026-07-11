import { INTENSITY_LIST } from "@/lib/constants";
import { cn } from "@/lib/utils";

/** A colored square/round intensity badge using the TREM theme tokens. */
export function IntensityBadge({
  i,
  className,
  round = false,
  blankAtZero = false,
}: {
  i: number;
  className?: string;
  round?: boolean;
  /** When true, render an empty (dark) square at intensity 0 instead of the "0" glyph — matches legacy #max-intensity. */
  blankAtZero?: boolean;
}) {
  const clamped = Math.max(0, Math.min(9, i | 0));
  return (
    <div
      className={cn(
        "box-border flex aspect-square select-none items-center justify-center font-bold leading-none tabular-nums",
        round ? "rounded-full" : "rounded-[25%]",
        className,
      )}
      style={{
        backgroundColor: `var(--intensity-${clamped})`,
        color: `var(--intensity-text-${clamped})`,
      }}
    >
      {blankAtZero && clamped === 0 ? null : INTENSITY_LIST[clamped]}
    </div>
  );
}
