import { useState } from "react";
import { ChevronLeft } from "lucide-react";

import { IntensityBadge } from "@/components/IntensityBadge";
import { extractLocation, formatReportTime } from "@/domain/utils";
import { useRerenderOn } from "@/hooks/useTremEvent";
import {
  getActiveReplayReportId,
  getReports,
  openReportUrl,
  replayReport,
} from "@/features/report/report";
import type { ReportListItem } from "@/lib/types";
import { variable } from "@/lib/variable";
import { cn } from "@/lib/utils";

interface SurveyItem {
  kind: "survey";
  id: "survey-item";
  time: number;
  int: number;
}

type PanelItem = { kind: "report"; report: ReportListItem } | SurveyItem;

/** Right-side report list, including the legacy survey and replay-highlight states. */
export function ReportPanel() {
  // Legacy collapses the 275px panel below 1080px so it does not cover most of
  // the map at the 900px minimum window width.
  const [open, setOpen] = useState(() => window.innerWidth >= 1080);
  useRerenderOn("ReportListUpdate", "ReportRelease");

  const survey: SurveyItem | null = variable.cache.intensity.time
    ? {
        kind: "survey",
        id: "survey-item",
        time: variable.cache.intensity.time,
        int: variable.cache.intensity.max,
      }
    : null;
  const items: PanelItem[] = [
    ...(survey ? [survey] : []),
    ...getReports().map((report) => ({ kind: "report" as const, report })),
  ];

  return (
    <div className={cn("legacy-report-panel", !open && "is-closed")}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title="地震報告"
        className="legacy-report-toggle"
      >
        <ChevronLeft className={cn("h-4 w-4", open && "rotate-180")} />
      </button>

      <div className="legacy-report-list">
        {items.map((item, index) =>
          index === 0 ? (
            <FeaturedItem key={item.kind === "survey" ? item.id : item.report.id} item={item} />
          ) : item.kind === "report" ? (
            <CompactReportRow key={item.report.id} item={item.report} />
          ) : null,
        )}
      </div>
    </div>
  );
}

function FeaturedItem({ item }: { item: PanelItem }) {
  if (item.kind === "survey") {
    return (
      <div className="legacy-report-card legacy-report-featured is-survey">
        <div className="legacy-report-featured-content">
          <div className="flex flex-col items-center">
            <IntensityBadge i={item.int} className="legacy-report-featured-badge h-[80px] w-[80px] rounded-[12px] text-[48px]" />
            <div className="mt-[0.3em] text-center text-[13px] font-bold">觀測最大震度</div>
          </div>
          <div className="ml-2 flex min-w-0 flex-1 flex-col">
            <div className="truncate text-[28px] font-bold leading-tight">震源調查中</div>
            <div className="text-[13px] font-bold">{formatReportTime(item.time)}</div>
          </div>
        </div>
      </div>
    );
  }

  const report = item.report;
  return (
    <div
      className={cn(
        "legacy-report-card legacy-report-featured group",
        isReplayActive(report) && "legacy-report-flashing",
      )}
    >
      <div className="legacy-report-featured-content">
        <div className="flex flex-col items-center">
          <IntensityBadge i={report.int ?? 0} className="legacy-report-featured-badge h-[80px] w-[80px] rounded-[12px] text-[48px]" />
          <div className="mt-[0.3em] text-center text-[13px] font-bold">觀測最大震度</div>
        </div>

        <div className="ml-2 flex min-w-0 flex-1 flex-col">
          <div className="truncate text-[28px] font-bold leading-tight">
            {extractLocation(report.loc)}
          </div>
          <div className="text-[13px] font-bold">{formatReportTime(report.time)}</div>
          <div className="mt-auto flex w-full items-baseline justify-between pt-[0.3em]">
            <div
              className="-mt-[5px] text-[30px] font-bold leading-none tabular-nums"
              style={isNumbered(report) ? { color: "var(--warning)" } : undefined}
            >
              <span className="mr-1">𝖬</span>
              {report.mag ? report.mag.toFixed(1) : "--"}
            </div>
            <div className="-mt-[3px] text-[24px] font-bold leading-9 tabular-nums">
              {report.depth}
              <span className="ml-1 text-[14px] font-normal">km</span>
            </div>
          </div>
        </div>
      </div>
      <ReportActions item={report} />
    </div>
  );
}

function CompactReportRow({ item }: { item: ReportListItem }) {
  return (
    <div
      className={cn(
        "legacy-report-card group flex items-center gap-2",
        isReplayActive(item) && "legacy-report-flashing",
      )}
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
          style={isNumbered(item) ? { color: "var(--warning)" } : undefined}
        >
          <span className="mr-1">𝖬</span>
          {item.mag ? item.mag.toFixed(1) : "--"}
        </div>
      </div>
      <ReportActions item={item} />
    </div>
  );
}

function ReportActions({ item }: { item: ReportListItem }) {
  return (
    <div className="legacy-report-actions">
      <button type="button" onClick={() => openReportUrl(item)}>
        {item.trem ? "檢知" : "報告"}
      </button>
      <button type="button" onClick={() => replayReport(item)}>
        重播
      </button>
    </div>
  );
}

function isNumbered(item: ReportListItem): boolean {
  return !item.id.split("-")[0]?.includes("000");
}

function isReplayActive(item: ReportListItem): boolean {
  return getActiveReplayReportId() === item.id;
}
