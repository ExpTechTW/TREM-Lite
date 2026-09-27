import { formatTime } from "@/domain/utils";
import { now } from "@/lib/ntp";
import { ui } from "@/lib/variable.ui";
import { variable } from "@/lib/variable";
import { useTick } from "@/hooks/useTremEvent";
import { cn } from "@/lib/utils";

/**
 * Bottom-left clock + connection state (ports the #time element of loop.js).
 *
 * Disconnected, the clock stops at the last data it received, in red: it then
 * reads when the connection was lost.
 */
export function TimeBar() {
  useTick(1000);
  const replay = variable.play_mode === 2 || variable.play_mode === 3;
  const error = ui.internetError;
  const lost = variable.cache.last_data_time;

  // Legacy .connect chip colours: error -> --danger, replay -> --warning, else --light.
  const timeColor = error ? "#ce3333" : replay ? "#ffca00" : "var(--light)";

  // Legacy `.connect #time` sits INSIDE the nav-bar row right after the buttons,
  // so this renders as an inline pill (NavBar owns the absolute positioning).
  return (
    <div
      className="flex min-w-[145px] items-center justify-around rounded-[5px] border-2 p-[3px]"
      style={{
        backgroundColor: "var(--panel-bg)",
        borderColor: "#00000008",
      }}
    >
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
