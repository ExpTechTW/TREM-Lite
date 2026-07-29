import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { IntensityBadge } from "@/components/IntensityBadge";
import { formatTimestamp } from "@/domain/utils";
import type { EewDisplay } from "@/lib/variable.ui";

type PipPayload = ({ noEew: boolean } & Partial<EewDisplay>) | null;

/** Compact always-on-top EEW window. Listens for 'update-pip-content'. */
export function PipView() {
  const [data, setData] = useState<PipPayload>(null);

  useEffect(() => {
    const un = listen<PipPayload>("update-pip-content", (e) => {
      const payload = e.payload;
      setData(payload);
      const win = getCurrentWindow();
      if (payload && !payload.noEew) void win.show();
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const eew = data && !data.noEew ? (data as EewDisplay) : null;

  return (
    <div
      data-tauri-drag-region
      className="flex h-screen w-screen flex-col justify-center gap-1 rounded-lg bg-card/95 px-3 py-2 text-foreground"
    >
      {!eew ? (
        <div className="text-center text-xs text-muted-foreground">目前無地震速報</div>
      ) : (
        <>
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold">{eew.unitText}</span>
            <span className="tabular-nums text-muted-foreground">第 {eew.serial} 報</span>
          </div>
          <div className="flex items-center gap-2">
            <IntensityBadge i={eew.max} className="h-10 w-10 text-lg" />
            <div className="min-w-0">
              <div className="truncate text-sm font-bold">{eew.loc}</div>
              <div className="flex gap-2 text-[11px] tabular-nums text-muted-foreground">
                <span>M {eew.nsspe ? "--" : eew.mag.toFixed(1)}</span>
                <span>{eew.depth}km</span>
                <span>{formatTimestamp(eew.time)}</span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
