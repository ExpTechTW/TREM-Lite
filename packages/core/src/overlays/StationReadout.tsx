import { IntensityBadge } from "@/components/IntensityBadge";
import { ui } from "@/lib/variable.ui";
import { useRerenderOn } from "@/hooks/useTremEvent";

/** "Your station" readout (from ui.currentStation + ui.rtsInfo): matches legacy .station-pga-wrapper. */
export function StationReadout() {
  useRerenderOn("DataRts");
  const s = ui.currentStation;
  if (!s) return null;

  return (
    <div
      className="pointer-events-none absolute left-[6.9rem] top-[10rem] z-[1000] flex flex-col text-[11px] font-medium"
      style={{ color: "var(--light)" }}
    >
      {/* 所在地震度、加速度 + 大震度徽章 */}
      <div
        className="mt-[5px] flex w-[224px] flex-row-reverse justify-between rounded-[5px] border p-[2px] text-center font-medium"
        style={{
          backgroundColor: "var(--panel-bg)",
          borderColor: "var(--panel-border)",
        }}
      >
        <div className="flex w-[160px] flex-col flex-wrap">
          <div className="text-start text-[17px] font-bold">
            {s.loc || "---"}
          </div>
          <div className="flex justify-between text-[14px] font-bold">
            <div className="flex">
              <span>震度</span>
              <span>{s.i}</span>
            </div>
            <div className="flex">
              <span>加速度</span>
              <span>{s.pga.toFixed(1)}</span>
            </div>
          </div>
        </div>
        <IntensityBadge
          i={s.i}
          className="h-[45px] w-[45px] rounded-[5px] text-[25px]"
        />
      </div>

      {/* level / trigger */}
      <div
        className="mt-[3px] flex w-[65px] flex-col rounded-[5px] border text-center text-[11px] font-medium"
        style={{
          backgroundColor: "var(--panel-bg)",
          borderColor: "var(--panel-border)",
        }}
      >
        <div className="flex items-center justify-between">
          <div>level</div>
          <div>{ui.rtsInfo.level}</div>
        </div>
        <div className="flex items-center justify-between">
          <div>trigger</div>
          <div>{ui.rtsInfo.trigger}</div>
        </div>
      </div>
    </div>
  );
}
