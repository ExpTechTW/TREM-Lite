import React from "react";
import ReactDOM from "react-dom/client";
import "@/styles/globals.css";

import { SettingsApp } from "@/features/settings/SettingsApp";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>,
);
