import { useState } from "react";
import { Crosshair, PictureInPicture2, Settings } from "lucide-react";

import { openSettings, togglePip } from "@/lib/windows";
import { focus_reset, isAutoFocusLocked } from "@/features/focus/focus";
import { useTremEvent } from "@/hooks/useTremEvent";

import { TimeBar } from "./TimeBar";

/**
 * Bottom-left control cluster — ports legacy `.nav-bar-wrapper`: a single flex ROW
 * of icon buttons followed by the inline time pill (legacy `.connect #time`).
 * left:3px / bottom:5px, 30×30 buttons with 20px icons, exactly like nav_bar/box.css.
 */
export function NavBar() {
  // 自動聚焦被使用者手動操作鎖定時，定位鈕變紅（對應舊版 #focus 紅/白）。
  const [locked, setLocked] = useState(isAutoFocusLocked());
  useTremEvent("FocusLockChange", (v) => setLocked(v));

  return (
    <div
      className="pointer-events-auto absolute bottom-[5px] left-[3px] z-30 flex flex-row items-center gap-[3px] text-[15px] font-medium"
      style={{ color: "var(--light)" }}
    >
      <NavPanelButton title="設定" onClick={() => void openSettings()}>
        <Settings className="h-5 w-5" />
      </NavPanelButton>
      <NavPanelButton
        title={locked ? "定位（自動追蹤已暫停，點按恢復）" : "定位"}
        onClick={() => focus_reset(true)}
      >
        <Crosshair className="h-5 w-5" style={locked ? { color: "#ff4d4d" } : undefined} />
      </NavPanelButton>
      <NavPanelButton title="子母畫面" onClick={() => void togglePip()}>
        <PictureInPicture2 className="h-5 w-5" />
      </NavPanelButton>
      <TimeBar />
    </div>
  );
}

function NavPanelButton({
  children,
  title,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="flex h-[30px] w-[30px] items-center justify-center rounded-[5px] border border-[#00000008] bg-[var(--panel-bg)] transition-colors hover:border-[#ffffff47] hover:bg-[#252424c7]"
      style={{ color: "var(--light)" }}
    >
      {children}
    </button>
  );
}
