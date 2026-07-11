import { IntensityBadge } from "@/components/IntensityBadge";
import { ui } from "@/lib/variable.ui";
import { useRerenderOn } from "@/hooks/useTremEvent";

/** Left-side stacked max observed intensity + max PGA readout (from ui, set by the rts module). */
export function MaxIntensity() {
  useRerenderOn("DataRts");
  return (
    <div
      className="pointer-events-none absolute left-1 top-[164px] z-[1000] flex flex-col text-center text-[11px] font-medium leading-none"
      style={{ color: "var(--light)" }}
    >
      {/* 最大觀測震度 */}
      <div
        className="flex flex-col items-center rounded-[5px] p-2"
        style={{
          backgroundColor: "var(--panel-bg)",
          border: "1px solid var(--panel-border)",
        }}
      >
        <span className="text-[14px]">最大觀測震度</span>
        <IntensityBadge
          i={ui.maxIntensity.i}
          blankAtZero
          className="h-[85px] w-[85px] rounded-[12px] text-[50px]"
        />
      </div>

      {/* 最大加速度 (PGA) */}
      <div
        className="mt-[3px] flex flex-col justify-center rounded-[5px] text-center"
        style={{
          backgroundColor: "var(--panel-bg)",
          border: "1px solid var(--panel-border)",
        }}
      >
        <span className="text-[14px]">最大加速度</span>
        <div
          className="flex h-5 flex-col justify-center rounded-b-[5px] text-[12px]"
          style={{
            backgroundColor: "var(--intensity-0)",
            color: "var(--intensity-text-0)",
          }}
        >
          {ui.maxPga.toFixed(2)} gal
        </div>
      </div>
    </div>
  );
}
