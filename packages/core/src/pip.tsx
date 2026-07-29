import React from "react";
import ReactDOM from "react-dom/client";
import "@/styles/globals.css";

import { PipView } from "@/features/pip/PipView";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PipView />
  </React.StrictMode>,
);
