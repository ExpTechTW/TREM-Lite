import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

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
  const updateScrollbarRef = useRef<() => void>(() => {});
  const [scrollbarVisible, setScrollbarVisible] = useState(false);
  const [canScroll, setCanScroll] = useState(false);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const updateScrollbar = () => {
      const canScroll = list.scrollHeight > list.clientHeight;
      setCanScroll(canScroll);
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
    const stopDragging = (event: PointerEvent) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.userSelect = "";
      const target = document.elementFromPoint(event.clientX, event.clientY);
      setScrollbarVisible(Boolean(target && (list.contains(target) || scrollbarRef.current?.contains(target))));
    };

    updateScrollbarRef.current = updateScrollbar;
    list.addEventListener("mouseenter", updateScrollbar);
    list.addEventListener("scroll", updateScrollbar);
    window.addEventListener("resize", updateScrollbar);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);
    updateScrollbar();
    return () => {
      updateScrollbarRef.current = () => {};
      list.removeEventListener("mouseenter", updateScrollbar);
      list.removeEventListener("scroll", updateScrollbar);
      window.removeEventListener("resize", updateScrollbar);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, []);

  // Legacy collapses the 275px panel below 1080px so it does not cover most of
  // the map at the 900px minimum window width.
  const [open, setOpen] = useState(() => window.innerWidth >= 1080);
  useRerenderOn("ReportListUpdate", "ReportRelease");
  useEffect(() => {
    updateScrollbarRef.current();
  });

  // An intensity survey under way is featured above every report; otherwise
  // the latest report is.
  const survey = variable.cache.intensity;

  return (
    <div className={cn("legacy-report-panel", !open && "is-closed")}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title={open ? "收合地震報告" : "展開地震報告"}
        aria-label={open ? "收合地震報告" : "展開地震報告"}
        aria-expanded={open}
        className="legacy-report-toggle"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <rect width="20" height="20" fill="#464646" />
          <path
            d="M12.646 14.166 11.257 15.605 5.52 10.076 11.249 4.419 12.649 5.843 8.382 10.058z"
            fill="var(--light)"
            transform={open ? "translate(20 0) scale(-1 1)" : undefined}
          />
        </svg>
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
        style={{ opacity: scrollbarVisible && canScroll ? 1 : 0, pointerEvents: scrollbarVisible && canScroll ? "auto" : "none" }}
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
        <div className="ml-2 flex w-full min-w-0 flex-col items-stretch max-[640px]:ml-0">
          <div className="min-w-0 font-bold">
            <div className="truncate text-[28px] max-[980px]:text-[21px] max-[640px]:text-[17px]">震源調查中</div>
            <div className="text-[13px] max-[980px]:text-[12px] max-[640px]:text-[11px]">{formatReportTime(time)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function setRippleOrigin(event: ReactPointerEvent<HTMLDivElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  event.currentTarget.style.setProperty("--x", `${event.clientX - rect.left}px`);
  event.currentTarget.style.setProperty("--y", `${event.clientY - rect.top}px`);
}

function FeaturedReport({ report }: { report: ReportListItem }) {
  return (
    <div
      className={cn(
        "legacy-report-card legacy-report-featured",
        isReplayActive(report) && "legacy-report-flashing",
      )}
      onPointerDown={setRippleOrigin}
    >
      <div className="legacy-report-featured-content">
        <div className="flex flex-col items-center">
          <IntensityBadge i={report.int ?? 0} className="legacy-report-featured-badge h-[80px] w-[80px] rounded-[12px] text-[48px]" />
          <div className="legacy-report-featured-label mt-[0.3em] text-center text-[13px] font-bold">觀測最大震度</div>
        </div>

        <div className="ml-2 flex w-full min-w-0 flex-col items-stretch max-[640px]:ml-0">
          <div className="min-w-0 font-bold">
            <div className="w-[7em] break-all text-[28px] max-[980px]:text-[21px] max-[640px]:text-[17px]">{extractLocation(report.loc)}</div>
            <div className="text-[13px] max-[980px]:text-[12px] max-[640px]:text-[11px]">{formatReportTime(report.time)}</div>
          </div>
          <div className="mt-[0.5em] mr-[0.3em] flex w-full justify-between">
            <div
              className="relative isolate flex h-[28px] tabular-nums"
              style={isNumbered(report) ? { color: "var(--warning)" } : undefined}
            >
              <span className="pointer-events-none absolute text-[28px] leading-[28px] font-bold opacity-[0.15] max-[640px]:text-[19px]">規模</span>
              <span className="-mt-[5px] text-[30px] font-bold max-[980px]:mt-1 max-[980px]:text-[20px] max-[640px]:mt-0 max-[640px]:text-[19px]"><span className="mr-1">𝖬</span>{report.mag ? report.mag.toFixed(1) : "--"}</span>
            </div>
            <div className="relative isolate flex h-[28px] w-[110px] justify-end tabular-nums max-[980px]:w-[95px] max-[640px]:w-auto">
              <span className="pointer-events-none absolute text-[28px] leading-[28px] font-bold opacity-[0.15] max-[640px]:text-[19px]">深度</span>
              <span className="-mt-[3px] text-[30px] leading-9 font-bold max-[980px]:mt-0 max-[980px]:text-[20px] max-[640px]:text-[15px] max-[640px]:leading-[1.4]">{report.depth}<span className="ml-1 inline-block text-[14px] leading-7 font-normal max-[640px]:text-[11px]">km</span></span>
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
      onPointerDown={setRippleOrigin}
    >
      <IntensityBadge
        i={item.int ?? 0}
        className="h-[50px] w-[55px] shrink-0 rounded-[12px] text-[30px] max-[980px]:h-[40px] max-[980px]:w-[43px] max-[980px]:text-[22px] max-[640px]:h-[38px] max-[640px]:w-[38px] max-[640px]:rounded-[9px] max-[640px]:text-[21px]"
      />
      <div className="flex min-w-0 flex-1 items-center justify-between pr-[0.3em]">
        <div className="min-w-0">
          <div className="max-w-[180px] truncate text-[21px] font-bold leading-tight max-[980px]:text-[17px] max-[640px]:max-w-none max-[640px]:text-[14px]">
            {extractLocation(item.loc)}
          </div>
          <div className="text-[13px] font-bold max-[980px]:text-[12px] max-[640px]:text-[11px]">{formatReportTime(item.time)}</div>
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
