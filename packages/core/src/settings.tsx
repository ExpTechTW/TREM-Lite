import React from "react";
import ReactDOM from "react-dom/client";
import { reactRootErrorHandlers } from "@/lib/logger";
import "@/styles/globals.css";

import { initPluginAdmin } from "@/features/plugin";
import { SettingsApp } from "@/features/settings/SettingsApp";

// The main window owns the extensions; this one only lists them and records
// what it changed. V3 read `enabled-plugins` at boot too, so a change here takes
// effect the next time the app starts.
initPluginAdmin();

ReactDOM.createRoot(document.getElementById("root")!, reactRootErrorHandlers).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>,
);
