import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

import { versionLabel } from "@/lib/version";

/** Top-right app version (legacy showed it in the top-right corner). */
export function VersionBadge() {
  // Empty until the build says what it is: the web has no version to show.
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion()
      .then((v) => setVersion(versionLabel(v)))
      .catch(() => {});
  }, []);

  if (!version) return null;
  return (
    <div
      className="legacy-version pointer-events-none absolute right-[350px] top-[0.3em] z-40 text-[15px]"
      style={{ color: "#ffffff4f" }}
    >
      {version}
    </div>
  );
}
