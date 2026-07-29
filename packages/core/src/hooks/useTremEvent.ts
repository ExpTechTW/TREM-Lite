import { useCallback, useEffect, useState } from "react";

import { events, type TremEvents } from "@/lib/events";

/** Subscribe a React component to a bus event for its lifetime. */
export function useTremEvent<K extends keyof TremEvents>(
  type: K,
  handler: (payload: TremEvents[K]) => void,
): void {
  useEffect(() => {
    const h = handler as (p: unknown) => void;
    events.on(type, h as never);
    return () => events.off(type, h as never);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);
}

/**
 * Re-render the component whenever any of the given bus events fire. Lets overlays
 * read from `ui`/`variable` on demand (event-driven) instead of polling on a timer.
 */
export function useRerenderOn<K extends keyof TremEvents>(...types: K[]): void {
  const [, setN] = useState(0);
  useEffect(() => {
    const h = () => setN((n) => n + 1);
    for (const t of types) events.on(t, h as never);
    return () => {
      for (const t of types) events.off(t, h as never);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types.join("|")]);
}

/** Re-render on an interval — for overlays that genuinely need time (e.g. a clock). */
export function useTick(ms: number): number {
  const [n, setN] = useState(0);
  const bump = useCallback(() => setN((x) => x + 1), []);
  useEffect(() => {
    const id = setInterval(bump, ms);
    return () => clearInterval(id);
  }, [ms, bump]);
  return n;
}
