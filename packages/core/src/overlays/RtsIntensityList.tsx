import { IntensityBadge } from "@/components/IntensityBadge";
import { useRerenderOn } from "@/hooks/useTremEvent";
import { ui } from "@/lib/variable.ui";

/** Bottom-right rolling 30-second peak ranking, matching legacy rts.js. */
export function RtsIntensityList() {
  useRerenderOn("DataRts");
  const rows = ui.rtsIntensityRows;

  if (!rows.length) return null;

  return (
    <div className="legacy-rts-list pointer-events-none absolute bottom-[3px] right-[19.5rem] mr-2 flex max-h-[300px] min-h-[180px] w-[145px]">
      <div className="z-[1001] flex min-h-0 flex-1 flex-col justify-end text-[var(--light)]">
        <div className="flex min-h-0 flex-col gap-[5px] rounded-[5px] bg-[var(--panel-bg)] p-1.5">
          <div className="text-center text-sm font-bold">各地震度排序</div>
          <div className="legacy-rts-list-scroll flex min-h-0 flex-col gap-1 overflow-y-hidden rounded hover:overflow-y-auto">
            {rows.map((row, index) => (
              <div
                key={`${row.name}-${index}`}
                className="flex rounded-[5px] border border-[#27272778] bg-[#383838]"
              >
                <IntensityBadge
                  i={row.i}
                  className="h-6 min-h-[24px] w-[26px] min-w-[26px] shrink-0 rounded-[5px] text-base"
                />
                <span className="flex w-full items-center justify-center text-sm font-bold">
                  {row.name}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
