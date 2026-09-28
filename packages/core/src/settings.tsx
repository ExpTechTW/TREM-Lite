import React from "react";
import ReactDOM from "react-dom/client";
import { reactRootErrorHandlers } from "@/lib/logger";
import "@/styles/globals.css";

import { SettingsApp } from "@/features/settings/SettingsApp";

ReactDOM.createRoot(document.getElementById("root")!, reactRootErrorHandlers).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>,
);
