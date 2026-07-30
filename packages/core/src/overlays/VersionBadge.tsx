import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

/** Top-right app version (legacy showed it in the top-right corner). */
export function VersionBadge() {
  const [version, setVersion] = useState("4.0.0");

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  return (
    <div
      className="pointer-events-none absolute left-[5px] bottom-[40px] z-40 text-[15px]"
      style={{ color: "#ffffff4f" }}
    >
      {version}
    </div>
  );
}
