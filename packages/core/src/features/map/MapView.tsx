import { useEffect, useRef } from "react";

import { initFeatures } from "@/features";
import { createLogger } from "@/lib/logger";
import { mark } from "@/lib/perf";

import { setupMap } from "./map";

const log = createLogger("map");

/** Full-bleed MapLibre canvas. Boots all feature modules then the map. */
export function MapView() {
  const ref = useRef<HTMLDivElement>(null);
  const booted = useRef(false);

  useEffect(() => {
    if (booted.current || !ref.current) return;
    booted.current = true;
    // Register every feature's event subscriptions BEFORE the map emits MapLoad.
    initFeatures();
    mark("features-init");
    setupMap(ref.current).catch((e) => log.error("boot failed", e));
  }, []);

  return <div ref={ref} className="absolute inset-0 h-full w-full" />;
}
