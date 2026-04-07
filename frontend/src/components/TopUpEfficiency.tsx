/**
 * TopUpEfficiency — analyses top-up patterns and efficiency.
 *
 * Kampong Grid styling:
 * - Key metric rows: label + value (font-mono)
 * - Each top-up as a compact row: date, amount, days lasted, efficiency %
 * - Flag debt-clearing in accent colour
 * - Fetches top-up history internally (like BalanceForecast)
 */
import type { Meter, ConsumptionRecord, TopUpRecord } from "../types/usms.js";

interface TopUpEfficiencyProps {
  meter: Meter;
  consumptionRecords: ConsumptionRecord[];
  topupRecords: TopUpRecord[];
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

function MetricRow({
  label,
  value,
  subValue,
  accentValue,
}: {
  label: string;
  value: string;
  subValue?: string;
  accentValue?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
      <span className="font-sans uppercase shrink-0" style={{ fontSize: "11px", color: "var(--text-tertiary)", letterSpacing: "0.08em" }}>
        {label}
      </span>
      <span className="font-mono text-right" style={{ fontSize: "16px", color: "var(--text-secondary)" }}>
        {accentValue && (
          <span style={{ color: "var(--accent-primary)" }}>{accentValue} </span>
        )}
        {value}
        {subValue && (
          <span style={{ fontSize: "11px", color: "var(--text-tertiary)" }}> {subValue}</span>
        )}
      </span>
    </div>
  );
}


function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-BN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function daysBetween(a: string, b: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round(
    (new Date(b).getTime() - new Date(a).getTime()) / msPerDay
  );
}

interface EnrichedTopUp {
  record: TopUpRecord;
  daysLasted: number | null; // null if it's the current (last) top-up still active
  isActive: boolean;
  efficiencyPct: number; // what fraction of topupAmount went to actual recharge
  debtCleared: number;
}

export function TopUpEfficiency({ meter, consumptionRecords, topupRecords }: TopUpEfficiencyProps) {
  if (topupRecords.length === 0) {
    return (
      <div>
        <SectionHeader>Top-Up Efficiency</SectionHeader>
        <p className="font-sans text-sm" style={{ color: "var(--text-tertiary)" }}>
          No top-up history available.
        </p>
      </div>
    );
  }

  // Sort chronologically ascending
  const sorted = [...topupRecords].sort((a, b) => a.topupDate.localeCompare(b.topupDate));
  const todayStr = new Date().toISOString().slice(0, 10);

  // Enrich each top-up with days lasted and efficiency
  const enriched: EnrichedTopUp[] = sorted.map((rec, i) => {
    const nextRec = sorted[i + 1] ?? null;
    const daysLasted = nextRec
      ? daysBetween(rec.topupDate, nextRec.topupDate)
      : null;
    const isActive = nextRec === null;
    const efficiencyPct =
      rec.topupAmount > 0
        ? Math.min(100, (rec.actualRechargeAmount / rec.topupAmount) * 100)
        : 100;
    const debtCleared = rec.topupAmount - rec.actualRechargeAmount;

    return { record: rec, daysLasted, isActive, efficiencyPct, debtCleared };
  });

  // Last 5 for display
  const recentEnriched = enriched.slice(-5).reverse();
  const lastEnriched = enriched[enriched.length - 1];

  // Averages (use all records)
  const completedTopups = enriched.filter((e) => e.daysLasted !== null);
  const avgDaysInterval =
    completedTopups.length > 0
      ? completedTopups.reduce((s, e) => s + (e.daysLasted ?? 0), 0) / completedTopups.length
      : null;

  const avgAmount =
    enriched.length > 0
      ? enriched.reduce((s, e) => s + e.record.topupAmount, 0) / enriched.length
      : 0;

  // Current daily consumption rate from consumptionRecords
  const avgDailyConsumption =
    consumptionRecords.length > 0
      ? consumptionRecords.reduce((s, r) => s + r.consumption, 0) / consumptionRecords.length
      : 0;

  // "BND 10 gets you ~X days"
  const unitLabel = meter.remainingUnitLabel;
  const referenceTopup = 10;
  let daysPerTenBnd: number | null = null;
  if (avgDailyConsumption > 0 && lastEnriched) {
    // Use most recent top-up's units credited / amount to derive a rate
    const recentUnitsPer10 =
      lastEnriched.record.topupAmount > 0
        ? (lastEnriched.record.unitsCredited / lastEnriched.record.topupAmount) * referenceTopup
        : 0;
    daysPerTenBnd =
      recentUnitsPer10 > 0 && avgDailyConsumption > 0
        ? recentUnitsPer10 / avgDailyConsumption
        : null;
  }

  // Trend: compare last completed duration vs average
  let trendText: string | null = null;
  let trendPositive = false;
  if (completedTopups.length >= 2 && avgDaysInterval !== null) {
    const lastCompleted = completedTopups[completedTopups.length - 1];
    const diff = (lastCompleted.daysLasted ?? 0) - avgDaysInterval;
    const absDiff = Math.abs(diff);
    if (absDiff >= 3) {
      trendPositive = diff > 0;
      trendText = diff > 0
        ? `▲ Top-ups lasting longer (good)`
        : `▼ Top-ups not lasting as long`;
    } else {
      trendText = "Consistent interval";
    }
  }

  // Days since last top-up (active one)
  const daysSinceLast = lastEnriched
    ? daysBetween(lastEnriched.record.topupDate, todayStr)
    : null;

  return (
    <div>
      <SectionHeader>Top-Up Efficiency</SectionHeader>

      {/* Key metrics */}
      <div className="mb-4">
        {avgDaysInterval !== null && (
          <MetricRow
            label="Average interval"
            value={`${avgDaysInterval.toFixed(0)} days`}
            subValue={`(${completedTopups.length} top-up${completedTopups.length !== 1 ? "s" : ""})`}
          />
        )}
        <MetricRow
          label="Average top-up"
          value={`BND ${avgAmount.toFixed(2)}`}
        />
        {daysPerTenBnd !== null && (
          <MetricRow
            label="BND 10 → est. coverage"
            value={`~${daysPerTenBnd.toFixed(0)} days`}
            subValue={`(${((lastEnriched.record.unitsCredited / lastEnriched.record.topupAmount) * referenceTopup).toFixed(1)} ${unitLabel})`}
          />
        )}
        {trendText && (
          <div className="flex items-center justify-between gap-4 py-1">
            <span className="font-sans shrink-0" style={{ fontSize: "12px", color: "var(--text-tertiary)" }}>
              Trend
            </span>
            <span
              className="font-sans text-right"
              style={{
                fontSize: "11px",
                color: trendText === "Consistent interval"
                  ? "var(--text-secondary)"
                  : trendPositive
                  ? "var(--color-school)"
                  : "var(--color-holiday)",
              }}
            >
              {trendText}
            </span>
          </div>
        )}
      </div>

      {/* Recent top-ups list */}
      <p
        className="font-sans font-medium uppercase mb-2"
        style={{ fontSize: "10px", color: "var(--text-tertiary)", letterSpacing: "0.1em" }}
      >
        Recent top-ups
      </p>

      <div>
        {recentEnriched.map((item, idx) => {
          const hasDebt = item.debtCleared > 0.005;
          const daysStr = item.isActive
            ? `${daysSinceLast ?? "?"} days (active)`
            : `${item.daysLasted} days`;
          const isEvenRow = idx % 2 === 1;

          return (
            <div
              key={item.record.transactionNo}
              style={{
                borderLeft: `2px solid ${item.isActive ? "var(--accent-primary)" : "var(--border-subtle)"}`,
                paddingLeft: "10px",
                paddingTop: "6px",
                paddingBottom: "6px",
                background: isEvenRow ? "rgba(36, 40, 50, 0.5)" : "transparent",
              }}
            >
              {/* Date + amount */}
              <div className="flex items-baseline justify-between gap-2 flex-wrap">
                <span
                  className="font-mono"
                  style={{
                    fontSize: "12px",
                    color: item.isActive ? "var(--text-primary)" : "var(--text-secondary)",
                  }}
                >
                  {formatDate(item.record.topupDate)}
                </span>
                <span className="font-mono" style={{ fontSize: "12px", color: "var(--accent-primary)" }}>
                  BND {item.record.topupAmount.toFixed(2)}
                </span>
              </div>

              {/* Duration + efficiency */}
              <div
                className="flex flex-wrap gap-x-4 gap-y-0.5 mt-0.5"
                style={{ fontSize: "12px", color: "var(--text-tertiary)" }}
              >
                <span>
                  Duration:{" "}
                  <span className="font-mono" style={{ color: "var(--text-secondary)" }}>
                    {daysStr}
                  </span>
                </span>

                {item.record.unitsCredited > 0 && (
                  <span>
                    Credited:{" "}
                    <span className="font-mono" style={{ color: "var(--text-secondary)" }}>
                      {item.record.unitsCredited.toFixed(2)} {unitLabel}
                    </span>
                  </span>
                )}

                <span>
                  Efficiency:{" "}
                  <span
                    className="font-mono"
                    style={{
                      color: item.efficiencyPct >= 99 ? "var(--color-school)" : "var(--accent-primary)",
                    }}
                  >
                    {item.efficiencyPct.toFixed(0)}%
                  </span>
                </span>
              </div>

              {/* Debt flag */}
              {hasDebt && (
                <p className="font-sans mt-0.5" style={{ fontSize: "11px", color: "var(--accent-primary)" }}>
                  BND {item.debtCleared.toFixed(2)} cleared debt ·{" "}
                  BND {item.record.actualRechargeAmount.toFixed(2)} to credit
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
