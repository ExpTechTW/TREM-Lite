import React from "react";
import ReactDOM from "react-dom/client";
import { reactRootErrorHandlers } from "@/lib/logger";
import "@/styles/globals.css";

import { PipView } from "@/features/pip/PipView";

ReactDOM.createRoot(document.getElementById("root")!, reactRootErrorHandlers).render(
  <React.StrictMode>
    <PipView />
  </React.StrictMode>,
);
