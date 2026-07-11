import { IntensityBadge } from "@/components/IntensityBadge";
import { formatTimestamp } from "@/domain/utils";
import { ui } from "@/lib/variable.ui";
import { useRerenderOn } from "@/hooks/useTremEvent";
import { cn } from "@/lib/utils";

/** Top-left EEW info card. Reads ui.currentEew (populated by the eew module). */
export function EewInfoBox() {
  useRerenderOn("EewDisplayUpdate");
  const eew = ui.currentEew;

  // Idle state — the legacy always shows a "no active EEW" panel top-left.
  if (!eew) {
    return (
      <div
        className="pointer-events-none absolute left-1 top-1 z-30 flex w-auto flex-col gap-2 rounded-[5px] border p-2"
        style={{
          backgroundColor: "var(--panel-bg)",
          borderColor: "var(--panel-border)",
          color: "var(--light)",
        }}
      >
        {/* info-title: legacy places the placeholder in .info-unit (15px bold) */}
        <div className="flex justify-between px-2 text-[15px] font-bold">
          <span>暫無生效中的地震預警</span>
          <span />
        </div>
        {/* info-body-wrapper: empty dark box in idle (info-box/footer are display:none) */}
        <div className="min-h-[93px] min-w-[18.9rem] rounded-[10px] bg-[#383838] p-2" />
      </div>
    );
  }

  // Legacy floods the whole info-wrapper with the status colour (--eew-s-*),
  // then nests a dark #383838 body inside it.
  const statusColor =
    eew.statusClass === "eew-alert"
      ? "var(--eew-s-alert)"
      : eew.statusClass === "eew-cancel"
        ? "var(--eew-s-cancel)"
        : eew.statusClass === "eew-rts"
          ? "var(--eew-s-rts)"
          : "var(--eew-s-warn)";

  const unitPrefix =
    eew.statusClass === "eew-alert"
      ? "緊急地震速報 "
      : eew.statusClass === "eew-cancel"
        ? "取消報 "
        : eew.statusClass === "eew-rts"
          ? "單點地震檢知 "
          : "地震速報 ";

  const numberText = `第${eew.serial}報${
    eew.statusClass === "eew-cancel" ? "(取消)" : eew.final ? "(最終報)" : ""
  }`;

  return (
    <div
      className={cn(
        "pointer-events-none absolute left-1 top-1 z-30 flex w-auto flex-col gap-2 rounded-[5px] border p-2",
      )}
      style={{
        backgroundColor: statusColor,
        borderColor: statusColor,
        color: "var(--light)",
      }}
    >
      {/* info-title */}
      <div className="flex justify-between px-2 text-[15px] font-bold">
        <span>
          {unitPrefix}
          {eew.unitText}
        </span>
        <span className="tabular-nums">{numberText}</span>
      </div>

      {/* info-body-wrapper */}
      <div className="relative flex min-h-[93px] min-w-[18.9rem] flex-col gap-[5px] rounded-[10px] bg-[#383838] p-2">
        {/* info-box */}
        <div className="flex h-[72px] gap-2">
          {/* info-title-wrapper */}
          <div className="mt-3 flex flex-col items-center justify-center">
            <IntensityBadge i={eew.max} className="h-[75px] w-[75px] rounded-xl text-[45px]" />
            <div className="mt-[5px] text-[12px] opacity-75">預估最大震度</div>
          </div>

          {/* info-more */}
          <div className="flex flex-1 flex-col gap-px">
            <div className="text-2xl font-bold">{eew.loc}</div>
            <div className="flex items-center gap-[5px] text-[13px] font-bold">
              <span className="tabular-nums">{formatTimestamp(eew.time)}</span>
              <span>發震</span>
            </div>

            {/* info-footer */}
            <div className="flex flex-col justify-evenly text-xs">
              {eew.nsspe ? (
                <div className="mt-1.5 text-[15px] font-bold leading-5">
                  NSSPE 無震源參數推算
                </div>
              ) : (
                <div className="flex justify-between gap-2">
                  {/* info-mag */}
                  <div className="relative isolate flex-1 overflow-hidden">
                    <div className="pointer-events-none absolute right-0 top-0 text-[30px] font-bold opacity-10">
                      規模
                    </div>
                    <div className="mt-2 min-w-[60px] text-left text-[26px] font-bold tabular-nums">
                      <span className="mr-1 text-[22px]">𝖬</span>
                      {eew.mag.toFixed(1)}
                    </div>
                  </div>
                  {/* info-depth */}
                  <div className="relative isolate flex-1 overflow-hidden">
                    <div className="pointer-events-none absolute right-0 top-0 text-[30px] font-bold opacity-10">
                      深度
                    </div>
                    <div className="mt-2 min-w-[60px] text-left text-[26px] font-bold tabular-nums">
                      {eew.depth}
                      <span className="ml-1 text-[22px]">㎞</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
