import { useState } from "react";
import { ChevronLeft, ExternalLink, Play } from "lucide-react";

import { IntensityBadge } from "@/components/IntensityBadge";
import { formatReportTime, extractLocation } from "@/domain/utils";
import { getReports, openReportUrl, replayReport } from "@/features/report/report";
import type { ReportListItem } from "@/lib/types";
import { useRerenderOn } from "@/hooks/useTremEvent";
import { cn } from "@/lib/utils";

/** Right-side collapsible earthquake report list (ports report-wrapper). */
export function ReportPanel() {
  const [open, setOpen] = useState(window.innerWidth >= 1080);
  // 列表載入/更新時立即刷新（事件驅動，不再輪詢），ReportRelease 為新報告發布。
  useRerenderOn("ReportListUpdate", "ReportRelease");

  const reports = getReports();

  return (
    <div className="absolute bottom-0 right-0 top-0 z-20 flex items-stretch">
      {/* report-list-btn (#close-btn) — 20px light toggle tab on the panel's left edge */}
      <button
        onClick={() => setOpen((o) => !o)}
        title="地震報告"
        className="my-auto flex h-14 w-[20px] items-center justify-center rounded-l-[6px] shadow-md"
        style={{ backgroundColor: "var(--light)", color: "var(--dark)" }}
      >
        <ChevronLeft className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
      </button>

      {/* report-box-items — 310px translucent grey scroll container */}
      {open && (
        <div
          className="flex w-[310px] flex-col gap-[4px] overflow-y-auto p-[3px] pt-[2px] shadow-xl"
          style={{ backgroundColor: "#464646d9" }}
        >
          {reports.length === 0 && (
            <div className="p-3 text-sm text-muted-foreground">尚無報告</div>
          )}
          {reports.map((r, i) =>
            i === 0 ? (
              <FeaturedReportCard key={r.id} item={r} />
            ) : (
              <CompactReportRow key={r.id} item={r} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** report-box-item-wrapper:first-child — large featured card. */
function FeaturedReportCard({ item }: { item: ReportListItem }) {
  return (
    <div
      className="group relative shrink-0 overflow-hidden rounded-[15px] border border-white/[0.22]"
      style={{ backgroundColor: "#292929", color: "var(--light)" }}
    >
      <div className="flex w-full gap-[8px] p-[10px]">
        {/* report-intensity-box */}
        <div className="flex flex-col items-center">
          <IntensityBadge i={item.int ?? 0} className="h-[80px] w-[80px] rounded-[12px] text-[48px]" />
          <div className="mt-[0.3em] text-center text-[13px] font-bold">觀測最大震度</div>
        </div>

        {/* report-info-box (legacy: column, top-aligned with the badge) */}
        <div className="ml-[0.5rem] flex min-w-0 flex-1 flex-col">
          <div className="truncate text-[28px] font-bold leading-tight">
            {extractLocation(item.loc)}
          </div>
          <div className="text-[13px] font-bold">{formatReportTime(item.time)}</div>

          {/* report-mag-dep — mt-auto pins it to the card bottom so the 規模/深度
              row lines up with 觀測最大震度 under the badge, as in legacy. */}
          <div className="mt-auto flex w-full items-baseline justify-between pt-[0.3em]">
            <div className="-mt-[5px] text-[30px] font-bold leading-none tabular-nums">
              <span className="mr-[4px]">𝖬</span>
              {item.mag ? item.mag.toFixed(1) : "--"}
            </div>
            <div className="-mt-[3px] text-[24px] font-bold leading-9 tabular-nums">
              {item.depth}
              <span className="ml-[4px] text-[14px] font-normal">km</span>
            </div>
          </div>
        </div>
      </div>

      <ReportActions item={item} />
    </div>
  );
}

/** report-box-item-wrapper (rest) — compact single-line row. */
function CompactReportRow({ item }: { item: ReportListItem }) {
  return (
    <div
      className="group relative flex shrink-0 items-center gap-[8px] overflow-hidden rounded-[15px] border border-white/[0.22]"
      style={{ backgroundColor: "#292929", color: "var(--light)" }}
    >
      <IntensityBadge
        i={item.int ?? 0}
        className="h-[50px] w-[55px] shrink-0 rounded-[12px] text-[30px]"
      />
      <div className="flex min-w-0 flex-1 items-center justify-between pr-[0.3em]">
        <div className="min-w-0">
          <div className="max-w-[180px] truncate text-[21px] font-bold leading-tight">
            {extractLocation(item.loc)}
          </div>
          <div className="text-[13px] font-bold">{formatReportTime(item.time)}</div>
        </div>
        <div
          className="w-[60px] shrink-0 pl-2 text-right text-[20px] font-bold tabular-nums"
          style={{ color: "var(--light)" }}
        >
          <span className="mr-[4px]">𝖬</span>
          {item.mag ? item.mag.toFixed(1) : "--"}
        </div>
      </div>

      <ReportActions item={item} />
    </div>
  );
}

/** report-buttons — hover overlay with web-report / replay actions. */
function ReportActions({ item }: { item: ReportListItem }) {
  return (
    <div
      className="absolute inset-0 hidden items-center justify-evenly group-hover:flex"
      style={{ backgroundColor: "#292929c4" }}
    >
      <button
        title="網頁報告"
        onClick={() => openReportUrl(item)}
        className="flex h-[22px] items-center gap-1 rounded-[5px] border border-white/30 px-2 text-[13px] font-bold hover:brightness-90"
        style={{ backgroundColor: "#505050", color: "var(--light)" }}
      >
        <ExternalLink className="h-3.5 w-3.5" />
        {item.trem ? "檢知" : "報告"}
      </button>
      <button
        title="重播"
        onClick={() => replayReport(item)}
        className="flex h-[22px] items-center gap-1 rounded-[5px] border border-white/30 px-2 text-[13px] font-bold hover:brightness-90"
        style={{ backgroundColor: "#505050", color: "var(--light)" }}
      >
        <Play className="h-3.5 w-3.5" />
        重播
      </button>
    </div>
  );
}
