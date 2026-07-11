import React from "react";
import ReactDOM from "react-dom/client";
import "maplibre-gl/dist/maplibre-gl.css";
import "@/styles/globals.css";

import { mark } from "@/lib/perf";
import { App } from "@/App";

mark("boot");

// Dev-only: expose the runtime singletons so the headless-WebKit debug harness
// (scripts/debug-live.mjs) can inspect map sources / data without a UI.
if (import.meta.env.DEV) {
  void Promise.all([import("@/lib/variable"), import("@/lib/events")]).then(
    ([{ variable }, { events }]) => {
      (window as unknown as { __trem: unknown }).__trem = { variable, events };
    },
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
