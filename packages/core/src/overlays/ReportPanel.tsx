import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronLeft, ExternalLink, Play, ScrollText, Square } from "lucide-react";

import { IntensityBadge } from "@/components/IntensityBadge";
import { formatReportTime, extractLocation } from "@/domain/utils";
import { getReports, openReportUrl, replayReport } from "@/features/report/report";
import type { ReportListItem } from "@/lib/types";
import { variable } from "@/lib/variable";
import { useRerenderOn } from "@/hooks/useTremEvent";
import { cn } from "@/lib/utils";
import { ScrollbarThumb } from "@/components/ui/scroll";

/** Right-side collapsible earthquake report list (ports report-wrapper). */
export function ReportPanel() {
  const [open, setOpen] = useState(window.innerWidth >= 1080);
  const [activeReplayItem, setActiveReplayItem] = useState<ReportListItem | null>(null);
  const [, setReplayRevision] = useState(0);
  // 列表載入/更新時立即刷新（事件驅動，不再輪詢），ReportRelease 為新報告發布。
  useRerenderOn("ReportListUpdate", "ReportRelease", "DataRts");

  const reports = getReports();
  const replayRunning = variable.play_mode === 2 || variable.play_mode === 3;
  const activeReplayStartTime = variable.replay.start_time;

  useEffect(() => {
    if (!replayRunning || !activeReplayStartTime) {
      setActiveReplayItem(null);
      return;
    }

    const matched = reports.find((item) => item.time - 5000 === activeReplayStartTime);
    if (matched) {
      setActiveReplayItem(matched);
    }
  }, [activeReplayStartTime, replayRunning, reports]);

  const displayReports =
    replayRunning &&
      activeReplayItem &&
      activeReplayItem.time - 5000 === activeReplayStartTime &&
      !reports.some((item) => item.id === activeReplayItem.id)
      ? [activeReplayItem, ...reports]
      : reports;

  return (
    <div className="pointer-events-auto absolute bottom-0 right-0 top-0 z-20">
      {/* report-list-btn (#close-btn) — 20px light toggle tab on the panel's left edge */}
      <button
        onClick={() => setOpen((o) => !o)}
        title="地震報告"
        className="absolute top-1/2 z-10 flex h-14 w-[20px] -translate-y-1/2 items-center justify-center rounded-l-[6px] shadow-md transition-[right,transform] duration-300 ease-out hover:cursor-pointer"
        style={{
          right: open ? "310px" : "0px",
          backgroundColor: "#464646d9",
        }}
      >
        <ChevronLeft className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
      </button>

      {/* report-box-items — 310px translucent grey scroll container */}
      <div
        className={cn(
          "absolute right-0 top-0 h-full min-h-0 overflow-hidden transition-[width,opacity,transform] duration-300 ease-out",
          open ? "w-[310px] translate-x-0 opacity-100" : "w-0 translate-x-3 opacity-0",
        )}
        aria-hidden={!open}
      >
        <CustomScrollbarPanel
          className={cn(
            "origin-right transition-[opacity,transform] duration-300 ease-out",
            open ? "translate-x-0 scale-x-100 opacity-100" : "translate-x-6 scale-x-95 opacity-0 pointer-events-none",
          )}
        >
          {displayReports.length === 0 && <EmptyReportState />}
          {displayReports.map((r, i) =>
            i === 0 ? (
              <FeaturedReportCard
                key={r.id}
                item={r}
                onReplayToggle={() => {
                  replayReport(r);
                  setActiveReplayItem(activeReplayStartTime === r.time - 5000 ? null : r);
                  setReplayRevision((value) => value + 1);
                }}
              />
            ) : (
              <CompactReportRow
                key={r.id}
                item={r}
                onReplayToggle={() => {
                  replayReport(r);
                  setActiveReplayItem(activeReplayStartTime === r.time - 5000 ? null : r);
                  setReplayRevision((value) => value + 1);
                }}
              />
            ),
          )}
        </CustomScrollbarPanel>
      </div>
    </div>
  );
}

function EmptyReportState() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-5 py-10 text-center">
      <div
        className="mb-2 flex h-[72px] w-[72px] items-center justify-center "
        style={{ color: "var(--light)" }}
      >
        <ScrollText className="h-9 w-9 opacity-35" strokeWidth={1.5} />
      </div>
      <div className="text-[15px] font-bold" style={{ color: "var(--light)" }}>
        尚無報告
      </div>
    </div>
  );
}

function CustomScrollbarPanel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const trackInset = 6;
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; startScrollTop: number } | null>(null);
  const [hovered, setHovered] = useState(false);
  const [metrics, setMetrics] = useState({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });

  const syncMetrics = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }

    setMetrics({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
  }, []);

  useEffect(() => {
    syncMetrics();
  }, [children, syncMetrics]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }

    syncMetrics();

    const resizeObserver = new ResizeObserver(() => syncMetrics());
    resizeObserver.observe(el);

    return () => resizeObserver.disconnect();
  }, [syncMetrics]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const el = scrollRef.current;
      const dragState = dragRef.current;
      if (!el || !dragState) {
        return;
      }

      const maxScrollTop = Math.max(el.scrollHeight - el.clientHeight, 0);
      if (maxScrollTop === 0) {
        return;
      }

      const scrollRatio = maxScrollTop / el.clientHeight;
      el.scrollTop = dragState.startScrollTop + (event.clientY - dragState.startY) * scrollRatio;
      syncMetrics();
    };

    const onPointerUp = () => {
      dragRef.current = null;
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [syncMetrics]);

  const maxScrollTop = Math.max(metrics.scrollHeight - metrics.clientHeight, 0);
  const hasOverflow = maxScrollTop > 0;
  const trackHeight = Math.max(metrics.clientHeight - trackInset * 2, 0);
  const thumbHeight = hasOverflow
    ? Math.min(Math.max((metrics.clientHeight / metrics.scrollHeight) * trackHeight, 48), trackHeight)
    : 0;
  const thumbTravel = Math.max(trackHeight - thumbHeight, 0);
  const thumbTop = maxScrollTop > 0 ? Math.min((metrics.scrollTop / maxScrollTop) * thumbTravel, thumbTravel) : 0;

  return (
    <div
      className={cn("relative h-full min-h-0 w-[310px] shadow-xl", className)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        ref={scrollRef}
        onScroll={syncMetrics}
        className="report-list-scroll flex h-full min-h-0 flex-col gap-[4px] overflow-y-auto p-[3px] pb-[6px] pt-[2px]"
        style={{
          ...hiddenScrollbarStyle,
          backgroundColor: "#464646d9",
        }}
      >
        {children}
      </div>

      <ScrollbarThumb
        hasOverflow={hasOverflow}
        hovered={hovered}
        thumbHeight={thumbHeight}
        thumbTop={thumbTop}
        scrollRef={scrollRef}
        dragRef={dragRef}
      />
    </div>
  );
}

const hiddenScrollbarStyle: CSSProperties = {
  scrollbarWidth: "none",
  msOverflowStyle: "none",
};

/** report-box-item-wrapper:first-child — large featured card. */
function FeaturedReportCard({
  item,
  onReplayToggle,
}: {
  item: ReportListItem;
  onReplayToggle: () => void;
}) {
  return (
    <div
      className="group relative shrink-0 overflow-hidden rounded-[15px] border border-white/[0.22]"
      style={{ backgroundColor: "#292929", color: "var(--light)" }}
    >
      <div className="flex w-full gap-[8px] px-[10px] pt-[10px] pb-[6px]">
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
          <div className="mt-auto flex w-full items-end justify-between pt-[0.3em]">
            <div className="-mt-[5px] text-[30px] font-bold leading-none tabular-nums">
              <span className="mr-[4px]">𝖬</span>
              {item.mag ? item.mag.toFixed(1) : "--"}
            </div>
            <div className="-mt-[5px] text-[30px] font-bold leading-none tabular-nums">
              {item.depth}
              <span className="ml-[4px] text-[14px] font-normal">km</span>
            </div>
          </div>
        </div>
      </div>
      <ReportActions item={item} onReplayToggle={onReplayToggle} />
    </div>
  );
}

/** report-box-item-wrapper (rest) — compact single-line row. */
function CompactReportRow({
  item,
  onReplayToggle,
}: {
  item: ReportListItem;
  onReplayToggle: () => void;
}) {
  return (
    <div
      className="group relative flex shrink-0 items-center gap-[8px] overflow-hidden rounded-[15px] border border-white/[0.22]"
      style={{ backgroundColor: "#292929", color: "var(--light)" }}
    >
      <div className="flex min-w-0 flex-1 items-center justify-between px-[0.2em]">
        <IntensityBadge
          i={item.int ?? 0}
          className="h-[40px] w-[43px] shrink-0 rounded-[12px] text-[30px]"
        />
        <div className="flex flex-1 items-center justify-between px-1">
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
      </div>
      <ReportActions item={item} onReplayToggle={onReplayToggle} />
    </div>
  );
}

/** report-buttons — hover overlay with web-report / replay actions. */
function ReportActions({
  item,
  onReplayToggle,
}: {
  item: ReportListItem;
  onReplayToggle: () => void;
}) {
  const isReplaying =
    (variable.play_mode === 2 || variable.play_mode === 3) && variable.replay.start_time === item.time - 5000;

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
        title={isReplaying ? "停止重播" : "重播"}
        onClick={onReplayToggle}
        className={cn(
          "flex h-[22px] items-center gap-1 rounded-[5px] border border-white/30 px-2 text-[13px] font-bold hover:brightness-90",
          isReplaying && "report-replay-active",
        )}
        style={{
          backgroundColor: isReplaying ? undefined : "#505050",
          color: isReplaying ? undefined : "var(--light)",
        }}
      >
        {isReplaying ? (
          <Square className="h-3.5 w-3.5 fill-current" />
        ) : (
          <Play className="h-3.5 w-3.5" />
        )}
        {isReplaying ? "停止重播" : "重播"}
      </button>
    </div>
  );
}
