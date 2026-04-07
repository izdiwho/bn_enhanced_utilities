import type { Meter } from "../types/usms.js";

interface MeterCardProps {
  meter: Meter;
  selected: boolean;
  onClick: () => void;
}

export function MeterCard({ meter, selected, onClick }: MeterCardProps) {
  const isElec = meter.meterType === "electricity";
  const accentColor = isElec ? "var(--color-electricity)" : "var(--color-water)";

  const lastUpdated = meter.lastUpdated
    ? new Date(meter.lastUpdated).toLocaleString("en-BN", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

  return (
    <button
      onClick={onClick}
      className="w-full text-left p-4 transition-all"
      style={{
        background: "var(--bg-surface)",
        border: selected ? `1px solid ${accentColor}` : "1px solid var(--border-subtle)",
        borderLeft: `3px solid ${accentColor}`,
        borderRadius: "4px",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <span className="font-sans font-semibold capitalize" style={{ color: "var(--text-primary)" }}>
            {meter.meterType}
          </span>
          <span className="font-mono ml-2" style={{ color: "var(--text-tertiary)", fontSize: "11px" }}>
            #{meter.meterNo}
          </span>
        </div>
        <span
          className="font-mono"
          style={{
            fontSize: "11px",
            padding: "2px 8px",
            borderRadius: "999px",
            background: meter.status === "ACTIVE" ? "rgba(80,138,104,0.15)" : "rgba(184,80,80,0.15)",
            color: meter.status === "ACTIVE" ? "var(--color-school)" : "var(--color-holiday)",
            fontWeight: 500,
          }}
        >
          {meter.status}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div>
          <p className="font-sans" style={{ color: "var(--text-tertiary)", fontSize: "11px" }}>Remaining</p>
          <p className="font-mono font-semibold mt-0.5" style={{ color: "var(--text-primary)", fontSize: "16px" }}>
            {meter.remainingUnit.toFixed(2)}{" "}
            <span className="font-normal" style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
              {meter.remainingUnitLabel}
            </span>
          </p>
        </div>
        <div>
          <p className="font-sans" style={{ color: "var(--text-tertiary)", fontSize: "11px" }}>Balance</p>
          <p className="font-mono font-semibold mt-0.5" style={{ color: "var(--text-primary)", fontSize: "16px" }}>
            BND {meter.remainingBalance.toFixed(2)}
          </p>
        </div>
      </div>

      <div className="mt-2 font-mono" style={{ color: "var(--text-tertiary)", fontSize: "11px" }}>
        Updated {lastUpdated}
      </div>
    </button>
  );
}
