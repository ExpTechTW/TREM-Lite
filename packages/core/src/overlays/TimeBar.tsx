import { formatTime } from "@/domain/utils";
import { restartForUpdate } from "@/features/update/update";
import { now } from "@/lib/ntp";
import { ui } from "@/lib/variable.ui";
import { variable } from "@/lib/variable";
import { useRerenderOn, useTick } from "@/hooks/useTremEvent";
import { cn } from "@/lib/utils";

/**
 * Bottom-left clock + connection state (ports the #time element of loop.js).
 *
 * Disconnected, the clock stops at the last data it received, in red: it then
 * reads when the connection was lost. A downloaded update waiting for a
 * restart is a one-line note above it, positioned out of the layout so it
 * takes no room from anything; a click restarts now.
 */
export function TimeBar() {
  useTick(1000);
  useRerenderOn("UpdateReady");
  const replay = variable.play_mode === 2 || variable.play_mode === 3;
  const error = ui.internetError;
  const lost = variable.cache.last_data_time;

  // Legacy .connect chip colours: error -> --danger, replay -> --warning, else --light.
  const timeColor = error ? "#ce3333" : replay ? "#ffca00" : "var(--light)";

  // Legacy `.connect #time` sits INSIDE the nav-bar row right after the buttons,
  // so this renders as an inline pill (NavBar owns the absolute positioning).
  return (
    <div
      className="relative flex min-w-[145px] items-center justify-around rounded-[5px] border-2 p-[3px]"
      style={{
        backgroundColor: "var(--panel-bg)",
        borderColor: "#00000008",
      }}
    >
      {ui.updateReady && (
        <button
          type="button"
          onClick={restartForUpdate}
          title="重新啟動以完成更新"
          className="absolute bottom-full left-0 mb-[3px] whitespace-nowrap rounded-[4px] bg-[var(--panel-bg)] px-[5px] py-[1px] text-[11px] font-medium text-[#8fd18f] hover:text-white"
        >
          新版本 {ui.updateReady} 已下載・點此重新啟動
        </button>
      )}
      <span
        className={cn("text-[15px] font-bold tabular-nums")}
        style={{ color: timeColor }}
        title={error ? "連線中斷的時間" : undefined}
      >
        {formatTime(error && lost ? lost : now())}
      </span>
    </div>
  );
}
