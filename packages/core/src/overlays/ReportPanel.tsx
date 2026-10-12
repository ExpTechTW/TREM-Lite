import { useEffect, useRef, useState } from "react";
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

/** Right-side report list, including the legacy survey and replay-highlight states. */
export function ReportPanel() {
  const listRef = useRef<HTMLDivElement>(null);
  const scrollbarRef = useRef<HTMLDivElement>(null);
  const scrollbarThumbRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const scrollbarSizeRef = useRef(0);
  const [scrollbarVisible, setScrollbarVisible] = useState(false);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const updateScrollbar = () => {
      const canScroll = list.scrollHeight > list.clientHeight;
      const height = canScroll
        ? Math.max(20, (list.clientHeight / list.scrollHeight) * list.clientHeight)
        : 0;
      scrollbarSizeRef.current = height;
      const maxTop = list.clientHeight - height;
      const top = canScroll && maxTop > 0
        ? (list.scrollTop / (list.scrollHeight - list.clientHeight)) * maxTop
        : 0;
      const thumb = scrollbarThumbRef.current;
      if (thumb) {
        thumb.style.height = `${height}px`;
        thumb.style.transform = `translateY(${top}px)`;
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!draggingRef.current) return;
      const track = scrollbarRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const maxTop = rect.height - scrollbarSizeRef.current;
      if (maxTop <= 0) return;
      const nextTop = Math.max(0, Math.min(maxTop, event.clientY - rect.top - scrollbarSizeRef.current / 2));
      list.scrollTop = (nextTop / maxTop) * (list.scrollHeight - list.clientHeight);
    };
    const stopDragging = () => {
      draggingRef.current = false;
      document.body.style.userSelect = "";
    };

    list.addEventListener("scroll", updateScrollbar);
    window.addEventListener("resize", updateScrollbar);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopDragging);
    updateScrollbar();
    return () => {
      list.removeEventListener("scroll", updateScrollbar);
      window.removeEventListener("resize", updateScrollbar);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopDragging);
    };
  }, []);

  // Legacy collapses the 275px panel below 1080px so it does not cover most of
  // the map at the 900px minimum window width.
  const [open, setOpen] = useState(() => window.innerWidth >= 1080);
  useRerenderOn("ReportListUpdate", "ReportRelease");

  // An intensity survey under way is featured above every report; otherwise
  // the latest report is.
  const survey = variable.cache.intensity;

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

      <div
        ref={listRef}
        className="legacy-report-list"
        onMouseEnter={() => setScrollbarVisible(true)}
        onMouseLeave={() => {
          if (!draggingRef.current) setScrollbarVisible(false);
        }}
      >
        {survey.time ? <SurveyCard time={survey.time} int={survey.max} /> : null}
        {getReports().map((report, index) =>
          index === 0 && !survey.time ? (
            <FeaturedReport key={report.id} report={report} />
          ) : (
            <CompactReportRow key={report.id} item={report} />
          ),
        )}
      </div>
      <div
        ref={scrollbarRef}
        className="legacy-report-scrollbar-wrapper"
        onMouseEnter={() => setScrollbarVisible(true)}
        onMouseLeave={() => {
          if (!draggingRef.current) setScrollbarVisible(false);
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          draggingRef.current = true;
          document.body.style.userSelect = "none";
          setScrollbarVisible(true);
        }}
        aria-hidden="true"
        style={{ opacity: scrollbarVisible ? 1 : 0 }}
      >
        <div ref={scrollbarThumbRef} className="legacy-report-scrollbar" />
      </div>
    </div>
  );
}

function SurveyCard({ time, int }: { time: number; int: number }) {
  return (
    <div className="legacy-report-card legacy-report-featured is-survey">
      <div className="legacy-report-featured-content">
        <div className="flex flex-col items-center">
          <IntensityBadge i={int} className="legacy-report-featured-badge h-[80px] w-[80px] rounded-[12px] text-[48px]" />
          <div className="legacy-report-featured-label mt-[0.3em] text-center text-[13px] font-bold">觀測最大震度</div>
        </div>
        <div className="ml-2 flex min-w-0 flex-1 flex-col">
          <div className="legacy-report-featured-loc whitespace-nowrap text-[28px] font-bold leading-tight">震源調查中</div>
          <div className="legacy-report-featured-time text-[13px] font-bold">{formatReportTime(time)}</div>
        </div>
      </div>
    </div>
  );
}

function FeaturedReport({ report }: { report: ReportListItem }) {
  return (
    <div
      className={cn(
        "legacy-report-card legacy-report-featured",
        isReplayActive(report) && "legacy-report-flashing",
      )}
    >
      <div className="legacy-report-featured-content">
        <div className="flex flex-col items-center">
          <IntensityBadge i={report.int ?? 0} className="legacy-report-featured-badge h-[80px] w-[80px] rounded-[12px] text-[48px]" />
          <div className="legacy-report-featured-label mt-[0.3em] text-center text-[13px] font-bold">觀測最大震度</div>
        </div>

        <div className="ml-2 flex min-w-0 flex-1 flex-col">
          <div className="legacy-report-featured-loc whitespace-nowrap text-[28px] font-bold leading-tight">
            {extractLocation(report.loc)}
          </div>
          <div className="legacy-report-featured-time text-[13px] font-bold">{formatReportTime(report.time)}</div>
          <div className="mt-auto flex w-full items-baseline justify-between pt-[0.3em]">
            <div
              className="legacy-report-featured-mag -mt-[5px] text-[30px] font-bold leading-none tabular-nums"
              style={isNumbered(report) ? { color: "var(--warning)" } : undefined}
            >
              <span className="mr-1">𝖬</span>
              {report.mag ? report.mag.toFixed(1) : "--"}
            </div>
            <div className="legacy-report-featured-depth -mt-[3px] text-[24px] font-bold leading-9 tabular-nums">
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
        "legacy-report-card flex items-center gap-2",
        isReplayActive(item) && "legacy-report-flashing",
      )}
    >
      <IntensityBadge
        i={item.int ?? 0}
        className="legacy-report-row-badge h-[50px] w-[55px] shrink-0 rounded-[12px] text-[30px]"
      />
      <div className="flex min-w-0 flex-1 items-center justify-between pr-[0.3em]">
        <div className="min-w-0">
          <div className="legacy-report-row-loc max-w-[180px] truncate text-[21px] font-bold leading-tight">
            {extractLocation(item.loc)}
          </div>
          <div className="legacy-report-row-time text-[13px] font-bold">{formatReportTime(item.time)}</div>
        </div>
        <div
          className="legacy-report-row-mag w-[60px] shrink-0 pl-2 text-right text-[20px] font-bold tabular-nums"
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
