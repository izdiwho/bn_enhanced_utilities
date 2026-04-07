/**
 * BillComparison — side-by-side comparison of current vs previous period.
 *
 * Kampong Grid styling:
 * - Two-column layout, labels at 11px, data values in font-mono
 * - Delta arrows (▲/▼) in colour: green for decrease (good), red for increase
 * - Compact — no card, no padding
 */
import type { ConsumptionRecord } from "../types/usms.js";
import type { ConsumptionDateRange } from "./DateRangePicker.js";
import { calculateCost, ELECTRICITY_TARIFF, WATER_TARIFF } from "../utils/tariff.js";

interface BillComparisonProps {
  records: ConsumptionRecord[];
  meterType: "electricity" | "water";
  unitLabel: string;
  dateRange: ConsumptionDateRange;
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

interface PeriodStats {
  label: string;
  totalConsumption: number;
  totalCost: number;
  avgDaily: number;
  days: number;
}

interface DeltaProps {
  value: number; // percentage change
  invertColor?: boolean; // if true, decrease = red (bad), increase = green (good)
}

function Delta({ value, invertColor = false }: DeltaProps) {
  if (!isFinite(value) || isNaN(value)) return null;

  const isIncrease = value > 0;
  const isDecrease = value < 0;
  const isNeutral = value === 0;

  // For bills: decrease = good (green), increase = bad (red)
  let color = "var(--text-tertiary)";
  if (!isNeutral) {
    if (invertColor) {
      color = isDecrease ? "var(--color-holiday)" : "var(--color-school)";
    } else {
      color = isDecrease ? "var(--color-school)" : "var(--color-holiday)";
    }
  }

  const arrow = isIncrease ? "▲" : isDecrease ? "▼" : "—";
  const absPct = Math.abs(value).toFixed(1);

  return (
    <span className="font-mono font-bold" style={{ fontSize: "16px", color }}>
      {isNeutral ? "—" : `${arrow} ${absPct}%`}
    </span>
  );
}

function pct(current: number, previous: number): number {
  if (previous === 0) return 0;
  return ((current - previous) / previous) * 100;
}

/**
 * Group records by "YYYY-MM" month key.
 */
function groupByMonth(records: ConsumptionRecord[]): Map<string, ConsumptionRecord[]> {
  const map = new Map<string, ConsumptionRecord[]>();
  for (const r of records) {
    const key = r.period.slice(0, 7);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }
  return map;
}

function computeStats(
  monthRecords: ConsumptionRecord[],
  tariff: ReturnType<typeof ELECTRICITY_TARIFF extends infer T ? () => T : never>,
  label: string,
  isPartial = false,
  totalDaysInMonth = 30
): PeriodStats {
  const totalConsumption = monthRecords.reduce((s, r) => s + r.consumption, 0);
  const days = monthRecords.length;

  let totalCost: number;
  let avgDaily: number;

  if (isPartial && days > 0) {
    // Normalize to full month for fair comparison
    avgDaily = totalConsumption / days;
    const projectedMonthly = avgDaily * totalDaysInMonth;
    totalCost = calculateCost(projectedMonthly, tariff as Parameters<typeof calculateCost>[1]);
  } else {
    totalCost = calculateCost(totalConsumption, tariff as Parameters<typeof calculateCost>[1]);
    avgDaily = days > 0 ? totalConsumption / days : 0;
  }

  return { label, totalConsumption, totalCost, avgDaily, days };
}

export function BillComparison({
  records,
  meterType,
  unitLabel,
  dateRange,
}: BillComparisonProps) {
  const tariff = meterType === "electricity" ? ELECTRICITY_TARIFF : WATER_TARIFF;

  if (records.length === 0) {
    return (
      <div>
        <SectionHeader>Bill Comparison</SectionHeader>
        <p className="font-sans text-sm" style={{ color: "var(--text-tertiary)" }}>
          No data to compare.
        </p>
      </div>
    );
  }

  const byMonth = groupByMonth(records);
  const monthKeys = Array.from(byMonth.keys()).sort();

  if (monthKeys.length < 2) {
    return (
      <div>
        <SectionHeader>Bill Comparison</SectionHeader>
        <p className="font-sans text-sm" style={{ color: "var(--text-tertiary)" }}>
          Need 2+ months of data for comparison.
        </p>
        {monthKeys.length === 1 && (
          <p className="font-sans text-xs mt-1" style={{ color: "var(--text-tertiary)" }}>
            Only{" "}
            <span className="font-mono">{monthKeys[0]}</span>{" "}
            is loaded. Select "Last 3 Months" to enable this view.
          </p>
        )}
      </div>
    );
  }

  // Use the two most recent months
  const prevKey = monthKeys[monthKeys.length - 2];
  const currKey = monthKeys[monthKeys.length - 1];
  const prevRecords = byMonth.get(prevKey)!;
  const currRecords = byMonth.get(currKey)!;

  // Determine if current month is partial
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const isCurrentPartial = currKey === todayKey;
  const daysInCurrMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();

  // For previous month, also determine its days in month
  const [prevYear, prevMonthNum] = prevKey.split("-").map(Number);
  const daysInPrevMonth = new Date(prevYear, prevMonthNum, 0).getDate();
  const prevIsPartial = prevRecords.length < daysInPrevMonth && !isCurrentPartial;

  const prevStats = computeStats(prevRecords, tariff as any, formatMonthLabel(prevKey), prevIsPartial, daysInPrevMonth);
  const currStats = computeStats(currRecords, tariff as any, formatMonthLabel(currKey), isCurrentPartial, daysInCurrMonth);

  const consumptionDelta = pct(currStats.totalConsumption, prevStats.totalConsumption);
  const costDelta = pct(currStats.totalCost, prevStats.totalCost);
  const dailyDelta = pct(currStats.avgDaily, prevStats.avgDaily);

  const rows: {
    label: string;
    prevValue: string;
    currValue: string;
    delta: number;
    prefix?: string;
  }[] = [
    {
      label: "Consumption",
      prevValue: `${prevStats.totalConsumption.toFixed(1)} ${unitLabel}`,
      currValue: `${currStats.totalConsumption.toFixed(1)} ${unitLabel}${isCurrentPartial ? "*" : ""}`,
      delta: consumptionDelta,
    },
    {
      label: "Est. cost",
      prevValue: `${prevStats.totalCost.toFixed(2)}`,
      currValue: `${currStats.totalCost.toFixed(2)}${isCurrentPartial ? "*" : ""}`,
      delta: costDelta,
      prefix: "BND",
    },
    {
      label: `Avg daily`,
      prevValue: `${prevStats.avgDaily.toFixed(2)} ${unitLabel}/day`,
      currValue: `${currStats.avgDaily.toFixed(2)} ${unitLabel}/day`,
      delta: dailyDelta,
    },
  ];

  return (
    <div>
      <SectionHeader>Bill Comparison</SectionHeader>

      {/* Column headers */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        <div />
        <div>
          <p
            className="font-sans font-medium"
            style={{ fontSize: "11px", color: "var(--text-tertiary)", letterSpacing: "0.05em" }}
          >
            {prevStats.label}
          </p>
          <p className="font-mono" style={{ fontSize: "10px", color: "var(--text-tertiary)" }}>
            {prevRecords.length} day{prevRecords.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div>
          <p
            className="font-sans font-medium"
            style={{ fontSize: "11px", color: "var(--text-secondary)", letterSpacing: "0.05em" }}
          >
            {currStats.label}
          </p>
          <p className="font-mono" style={{ fontSize: "10px", color: "var(--text-tertiary)" }}>
            {currRecords.length} day{currRecords.length !== 1 ? "s" : ""}
            {isCurrentPartial ? " (partial)" : ""}
          </p>
        </div>
      </div>

      {/* Data rows */}
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-3 gap-2 items-baseline">
            {/* Row label */}
            <p
              className="font-sans"
              style={{ fontSize: "11px", color: "var(--text-tertiary)" }}
            >
              {row.label}
            </p>

            {/* Previous value */}
            <p className="font-mono" style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
              {row.prefix && (
                <span style={{ fontSize: "10px", color: "var(--text-tertiary)" }}>
                  {row.prefix}{" "}
                </span>
              )}
              {row.prevValue}
            </p>

            {/* Current value + delta */}
            <div className="flex items-baseline gap-2 flex-wrap">
              <p
                className="font-mono font-semibold"
                style={{ fontSize: "20px", color: "var(--text-primary)" }}
              >
                {row.prefix && (
                  <span
                    className="font-normal"
                    style={{ fontSize: "10px", color: "var(--text-tertiary)" }}
                  >
                    {row.prefix}{" "}
                  </span>
                )}
                {row.currValue}
              </p>
              <Delta value={row.delta} />
            </div>
          </div>
        ))}
      </div>

      {/* Footer notes */}
      <div className="mt-3 space-y-1">
        {isCurrentPartial && (
          <p className="font-sans" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
            * {currStats.label} is incomplete ({currRecords.length} of {daysInCurrMonth} days).
            Cost normalised to full month at current daily rate.
          </p>
        )}
        {dateRange.preset === "last3Months" && monthKeys.length >= 3 && (
          <p className="font-sans" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
            Comparing the two most recent months from your 3-month window.
          </p>
        )}
      </div>
    </div>
  );
}

function formatMonthLabel(key: string): string {
  const [year, month] = key.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("en-BN", {
    month: "short",
    year: "numeric",
  });
}
