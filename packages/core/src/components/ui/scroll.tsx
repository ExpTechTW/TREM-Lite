import * as React from "react";
import { cn } from "@/lib/utils";

interface ScrollbarThumbProps {
    hasOverflow: boolean;
    hovered: boolean;
    thumbHeight: number;
    thumbTop: number;
    scrollRef: React.RefObject<HTMLDivElement | null>;
    dragRef: React.MutableRefObject<{
        startY: number;
        startScrollTop: number;
    } | null>;
}

export function ScrollbarThumb({
    hasOverflow,
    hovered,
    thumbHeight,
    thumbTop,
    scrollRef,
    dragRef,
}: ScrollbarThumbProps) {
    if (!hasOverflow) return null;

    return (
        <div
            className={cn(
                "pointer-events-none absolute bottom-[6px] right-[4px] top-[6px] z-10 w-[8px] rounded-full bg-black/20 transition-opacity duration-150",
                hovered ? "opacity-100" : "opacity-0",
            )}
        >
            <button
                type="button"
                aria-label="拖曳捲動"
                className="pointer-events-auto absolute left-0 w-full rounded-full bg-white/70 transition-colors hover:bg-white/85"
                style={{
                    height: `${thumbHeight}px`,
                    transform: `translateY(${thumbTop}px)`,
                }}
                onPointerDown={(event) => {
                    dragRef.current = {
                        startY: event.clientY,
                        startScrollTop: scrollRef.current?.scrollTop ?? 0,
                    };

                    event.preventDefault();
                }}
            />
        </div>
    );
}