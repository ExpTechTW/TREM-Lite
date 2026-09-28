import React from "react";
import ReactDOM from "react-dom/client";
import { reactRootErrorHandlers } from "@/lib/logger";
import "maplibre-gl/dist/maplibre-gl.css";
import "@/styles/globals.css";

import { mark } from "@/lib/perf";
import { App } from "@/App";

mark("boot");

// Dev-only: expose the runtime singletons so the headless-WebKit debug harness
// (scripts/debug-live.mjs) can inspect map sources / data without a UI.
if (import.meta.env.DEV) {
  void Promise.all([import("@/lib/variable"), import("@/lib/events"), import("@/lib/variable.ui")]).then(
    ([{ variable }, { events }, { ui }]) => {
      (window as unknown as { __trem: unknown }).__trem = { variable, events, ui };
    },
  );
}

ReactDOM.createRoot(document.getElementById("root")!, reactRootErrorHandlers).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
