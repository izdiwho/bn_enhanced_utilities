/**
 * AnomalyDetector — flags statistically unusual consumption days.
 *
 * Kampong Grid styling:
 * - Each row: date left-aligned (font-mono), value right-aligned (font-mono, bright),
 *   sigma badge right-most (colored background, immediately parseable)
 * - 1px row separators
 * - Instantly parseable: bright values, dim labels
 *
 * Algorithm:
 *  - Compute mean and std dev of daily consumption.
 *  - Flag days > mean + 2σ as "high" anomalies.
 *  - Flag days < mean - 2σ as "low" anomalies.
 *  - For water meters: flag if minimum never drops near-zero (possible leak).
 */
import type { ConsumptionRecord } from "../types/usms.js";

interface AnomalyDetectorProps {
  records: ConsumptionRecord[];
  meterType: "electricity" | "water";
  unitLabel: string;
}

interface Anomaly {
  date: string;
  consumption: number;
  sigma: number;
  direction: "high" | "low";
}

function computeStats(values: number[]): { mean: number; stddev: number } {
  const n = values.length;
  if (n === 0) return { mean: 0, stddev: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return { mean, stddev: Math.sqrt(variance) };
}

function formatDate(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00");
  return d.toLocaleDateString("en-BN", { day: "numeric", month: "short" });
}

const HIGH_CAUSE_ELEC = "guests, AC marathon, or appliance fault";
const HIGH_CAUSE_WATER = "guests, irrigation, or pipe issue";
const LOW_CAUSE = "away from home, or meter read error";

const MAX_SHOWN = 5;

export function AnomalyDetector({ records, meterType, unitLabel }: AnomalyDetectorProps) {
  if (records.length < 7) {
    return (
      <div>
        <SectionHeader>Anomalies</SectionHeader>
        <p className="font-sans text-sm" style={{ color: "var(--text-tertiary)" }}>
          Need at least 7 days of data to detect anomalies.
        </p>
      </div>
    );
  }

  const values = records.map((r) => r.consumption);
  const { mean, stddev } = computeStats(values);

  const anomalies: Anomaly[] = [];
  for (const record of records) {
    if (stddev === 0) continue;
    const sigma = (record.consumption - mean) / stddev;
    if (sigma > 2) {
      anomalies.push({ date: record.period, consumption: record.consumption, sigma, direction: "high" });
    } else if (sigma < -2) {
      anomalies.push({ date: record.period, consumption: record.consumption, sigma, direction: "low" });
    }
  }

  // Sort by absolute sigma descending
  anomalies.sort((a, b) => Math.abs(b.sigma) - Math.abs(a.sigma));

  // Water leak heuristic
  const minConsumption = Math.min(...values);
  const leakWarning =
    meterType === "water" &&
    records.length >= 14 &&
    mean > 0 &&
    minConsumption > mean * 0.3
      ? `Min daily ${minConsumption.toFixed(2)} ${unitLabel} — never near zero. Possible slow leak.`
      : null;

  const shown = anomalies.slice(0, MAX_SHOWN);
  const hiddenCount = anomalies.length - shown.length;

  return (
    <div>
      <SectionHeader>Anomalies</SectionHeader>

      {/* Context line — font-mono for stats */}
      <p className="font-sans text-xs mb-3" style={{ color: "var(--text-tertiary)" }}>
        Mean{" "}
        <span className="font-mono" style={{ color: "var(--text-secondary)" }}>{mean.toFixed(2)}</span>
        {" "}{unitLabel} · σ{" "}
        <span className="font-mono" style={{ color: "var(--text-secondary)" }}>{stddev.toFixed(2)}</span>
        {" · "}
        {anomalies.length === 0
          ? "No outliers"
          : `${anomalies.length} outlier${anomalies.length > 1 ? "s" : ""}`}
      </p>

      {leakWarning && (
        <p className="font-sans text-xs mb-3" style={{ color: "var(--color-holiday)" }}>
          {leakWarning}
        </p>
      )}

      {anomalies.length === 0 ? (
        <p className="font-sans text-sm" style={{ color: "var(--text-tertiary)" }}>
          All readings within normal range.
        </p>
      ) : (
        <div className="space-y-0">
          {shown.map((a) => {
            const isHigh = a.direction === "high";
            const accentColor = isHigh ? "var(--color-holiday)" : "var(--color-water)";
            return (
              <div
                key={a.date}
                className="flex items-center gap-2 py-2"
                style={{ borderBottom: "1px solid var(--border-subtle)" }}
              >
                {/* Direction arrow — immediately signals high/low */}
                <span
                  style={{
                    color: accentColor,
                    fontSize: "11px",
                    width: "12px",
                    flexShrink: 0,
                    lineHeight: 1,
                  }}
                >
                  {isHigh ? "▲" : "▼"}
                </span>

                {/* Date — left-aligned, font-mono */}
                <span
                  className="font-mono"
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "12px",
                    minWidth: "52px",
                    flexShrink: 0,
                  }}
                >
                  {formatDate(a.date)}
                </span>

                {/* Spacer */}
                <span className="flex-1" />

                {/* Value — right-aligned, bright */}
                <span
                  className="font-mono"
                  style={{
                    color: "var(--text-primary)",
                    fontSize: "13px",
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                >
                  {a.consumption.toFixed(2)}{" "}
                  <span style={{ color: "var(--text-tertiary)", fontWeight: 400, fontSize: "11px" }}>
                    {unitLabel}
                  </span>
                </span>

                {/* Sigma badge — colored background, right-most */}
                <span
                  className="font-mono"
                  style={{
                    fontSize: "11px",
                    padding: "2px 7px",
                    borderRadius: "2px",
                    background: isHigh ? "rgba(196,88,88,0.15)" : "rgba(64,160,173,0.15)",
                    color: accentColor,
                    fontWeight: 600,
                    flexShrink: 0,
                    minWidth: "40px",
                    textAlign: "center",
                  }}
                >
                  {Math.abs(a.sigma).toFixed(1)}σ
                </span>
              </div>
            );
          })}

          {/* Cause hint below list */}
          {shown.length > 0 && (
            <p className="font-sans pt-2" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
              Possible causes: {shown[0].direction === "high"
                ? meterType === "electricity" ? HIGH_CAUSE_ELEC : HIGH_CAUSE_WATER
                : LOW_CAUSE}
            </p>
          )}
          {hiddenCount > 0 && (
            <p className="font-sans pt-1" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
              +{hiddenCount} more outlier{hiddenCount > 1 ? "s" : ""} not shown
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="font-sans font-medium uppercase mb-3"
      style={{
        color: "var(--text-tertiary)",
        fontSize: "11px",
        letterSpacing: "0.12em",
      }}
    >
      {children}
    </p>
  );
}
