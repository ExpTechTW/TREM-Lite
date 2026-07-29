import { useState } from "react";

import { IntensityBadge } from "@/components/IntensityBadge";
import { search_loc_name } from "@/domain/utils";
import { variable } from "@/lib/variable";
import type { RtsData } from "@/lib/types";
import { useTremEvent } from "@/hooks/useTremEvent";

interface Row {
  code: number;
  i: number;
  name: string;
}

/** Right-side live station intensity ranking (from variable.data.rts.int). */
export function RtsIntensityList() {
  const [rows, setRows] = useState<Row[]>([]);

  useTremEvent("DataRts", () => {
    const rts = variable.data.rts as RtsData | null;
    if (!rts?.int?.length) {
      setRows([]);
      return;
    }
    const next = [...rts.int]
      .sort((a, b) => b.i - a.i)
      .slice(0, 12)
      .map((r) => {
        const loc = search_loc_name(r.code);
        return { code: r.code, i: r.i, name: loc ? `${loc.city}${loc.town}` : String(r.code) };
      });
    setRows(next);
  });

  if (!rows.length) return null;

  return (
    <div className="pointer-events-none absolute bottom-[3px] right-[19.5rem] mr-2 flex max-h-[300px] min-h-[180px] w-[145px]">
      <div className="z-[1001] flex min-h-0 flex-1 flex-col justify-end text-[var(--light)]">
        <div className="flex min-h-0 flex-col gap-[5px] rounded-[5px] bg-[var(--panel-bg)] p-1.5">
          <div className="text-center text-sm font-bold">各地震度排序</div>
          <div className="flex min-h-0 flex-col gap-1 overflow-y-hidden rounded hover:overflow-y-auto">
            {rows.map((r) => (
              <div
                key={r.code}
                className="flex rounded-[5px] border border-[#27272778] bg-[#383838]"
              >
                <IntensityBadge
                  i={r.i}
                  className="h-6 min-h-[24px] w-[26px] min-w-[26px] shrink-0 rounded-[5px] text-base"
                />
                <span className="flex w-full items-center justify-center text-sm font-bold">
                  {r.name}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
