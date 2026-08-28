import { IntensityBadge } from "@/components/IntensityBadge";
import { formatTime } from "@/domain/utils";
import { useRerenderOn } from "@/hooks/useTremEvent";
import type { EewDisplay, RtsTriggerDisplay } from "@/lib/variable.ui";
import { ui } from "@/lib/variable.ui";
import { cn } from "@/lib/utils";

interface EewPanelProps {
  eew: EewDisplay | null;
  trigger?: RtsTriggerDisplay | null;
  variant?: "main" | "pip";
}

/** Top-left EEW / RTS trigger card, preserving the three legacy visual states. */
export function EewInfoBox() {
  useRerenderOn("EewDisplayUpdate");
  return <EewPanel eew={ui.currentEew} trigger={ui.currentTrigger} />;
}

/** Shared by the main overlay and the independent PiP webview. */
export function EewPanel({ eew, trigger = null, variant = "main" }: EewPanelProps) {
  const triggerTone = trigger
    ? trigger.max > 3
      ? "trigger-high"
      : trigger.max > 1
        ? "trigger-middle"
        : "trigger-low"
    : null;

  const stateClass = eew?.statusClass ?? triggerTone ?? "idle";
  const heading = eew
    ? `${unitPrefix(eew)}${eew.unitText}`
    : trigger
      ? triggerLabel(trigger.max)
      : "暫無生效中的地震預警";

  return (
    <div className={cn("legacy-eew-panel", `is-${stateClass}`, variant === "pip" && "is-pip")}>
      <div className="legacy-eew-title">
        <span>{heading}</span>
        {eew && <span className="tabular-nums">{reportNumber(eew)}</span>}
      </div>

      <div className="legacy-eew-body">
        {eew ? (
          <EewDetails eew={eew} />
        ) : trigger ? (
          <div className="legacy-trigger-grid">
            {trigger.locations.map((location, index) => (
              <span key={`${location.name}-${index}`}>{location.name}</span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function EewDetails({ eew }: { eew: EewDisplay }) {
  return (
    <div className="legacy-eew-details">
      <div className="legacy-eew-intensity-wrap">
        <IntensityBadge i={eew.max} className="legacy-eew-intensity" />
        <div className="legacy-eew-intensity-label">預估最大震度</div>
      </div>

      <div className="legacy-eew-more">
        <div className="legacy-eew-location">{eew.loc}</div>
        <div className="legacy-eew-time">
          <span className="tabular-nums">{formatTime(eew.time)}</span>
          <span>發震</span>
        </div>
        {eew.nsspe ? (
          <div className="legacy-eew-nsspe">NSSPE 無震源參數推算</div>
        ) : (
          <div className="legacy-eew-mag-depth">
            <Measurement label="規模">
              <span className="legacy-measure-prefix">𝖬</span>
              {eew.mag.toFixed(1)}
            </Measurement>
            <Measurement label="深度">
              {eew.depth}
              <span className="legacy-measure-suffix">㎞</span>
            </Measurement>
          </div>
        )}
      </div>
    </div>
  );
}

function Measurement({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="legacy-eew-measure">
      <span className="legacy-eew-measure-label">{label}</span>
      <span className="legacy-eew-measure-value tabular-nums">{children}</span>
    </div>
  );
}

function unitPrefix(eew: EewDisplay): string {
  if (eew.statusClass === "eew-alert") return "緊急地震速報 ";
  if (eew.statusClass === "eew-cancel") return "取消報 ";
  if (eew.statusClass === "eew-rts") return "單點地震檢知 ";
  return "地震速報 ";
}

function reportNumber(eew: EewDisplay): string {
  const suffix = eew.statusClass === "eew-cancel" ? "(取消)" : eew.final ? "(最終報)" : "";
  return `第${eew.serial}報${suffix}`;
}

function triggerLabel(max: number): string {
  if (max > 3) return "強震檢測";
  if (max > 1) return "震動檢測";
  return "弱反應";
}
