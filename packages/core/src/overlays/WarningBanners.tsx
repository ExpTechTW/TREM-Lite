import { AlertTriangle, WifiOff } from "lucide-react";

import { ui } from "@/lib/variable.ui";
import { useRerenderOn } from "@/hooks/useTremEvent";

/** Top-right warning banners (ports warning-message-box): no-internet + unstable. */
export function WarningBanners() {
  useRerenderOn("DataRts", "InternetErrorChange");
  if (!ui.internetError && !ui.unstable) return null;

  return (
    <div className="pointer-events-none absolute right-[315px] top-[5px] z-40 flex flex-col items-center gap-[5px] text-[15px] border-1 border-[#00000ab] rounded-md"
      style={{ backgroundColor: "#000000ab" }}
    >
      {ui.internetError && (
        <Banner
          icon={<WifiOff className="h-[25px] w-[25px]" />}
          title="網路異常"
          lines={["網路連線異常", "請待稍後重試"]}
          tone="error"
        />
      )}
      {ui.unstable && (
        <Banner
          icon={<AlertTriangle className="h-[25px] w-[25px]" />}
          title="不穩定"
          lines={["受地震活動的影響", "觀測點可能不穩定"]}
          tone="warn"
        />
      )}
    </div>
  );
}

function Banner({
  icon,
  title,
  lines,
  tone,
}: {
  icon: React.ReactNode;
  title: string;
  lines: string[];
  tone: "error" | "warn";
}) {
  const accent = tone === "warn" ? "var(--rts-trigger-middle)" : "var(--rts-trigger-high)";
  return (
    <div
      className="flex flex-col gap-[3px] px-2.5 py-[5px] min-w-[160px]"
    >
      <div className="flex items-center gap-2 font-bold justify-center" style={{ color: accent }}>
        {icon}
        <span>{title}</span>
      </div>
      <div className="flex flex-col text-[14px] justify-center items-center" style={{ color: "var(--light)" }}>
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </div>
    </div>
  );
}
