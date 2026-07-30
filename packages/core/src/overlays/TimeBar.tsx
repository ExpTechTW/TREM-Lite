import { formatTime } from "@/domain/utils";
import { now } from "@/lib/ntp";
import { ui } from "@/lib/variable.ui";
import { variable } from "@/lib/variable";
import { useTick } from "@/hooks/useTremEvent";
import { cn } from "@/lib/utils";

/** Bottom-left clock + connection state (ports the #time element of loop.js). */
export function TimeBar() {
  useTick(1000);
  const replay = variable.play_mode === 2 || variable.play_mode === 3;
  const error = ui.internetError;

  // Legacy .connect chip colours: error -> --danger, replay -> --warning, else --light.
  const timeColor = error ? "#ce3333" : replay ? "#ffca00" : "var(--light)";

  // Legacy `.connect #time` sits INSIDE the nav-bar row right after the buttons,
  // so this renders as an inline pill (NavBar owns the absolute positioning).
  return (
    <div
      className="flex min-w-[145px] items-center justify-around rounded-[5px] border-2 px-[3px] py-[2.3px]"
      style={{
        backgroundColor: "var(--panel-bg)",
        borderColor: "#00000008",
      }}
    >
      <span
        className={cn("text-[15px] font-bold tabular-nums")}
        style={{ color: timeColor }}
      >
        {formatTime(now())}
      </span>
    </div>
  );
}
