/**
 * SummaryStats — 4 stat cells in a row, no card wrappers.
 *
 * Kampong Grid styling:
 * - Label ABOVE the value (11px uppercase, --text-tertiary)
 * - Value in large font-mono (24px semibold), bright --text-primary
 * - For BND cost cells: currency prefix is slightly dimmer than the number
 * - Unit suffix in font-mono lighter weight, --text-secondary
 * - Cells separated by 1px --border-subtle vertical lines
 * - No padding around the whole row — flush under section label
 * Mobile: 2×2 grid with horizontal separator.
 */
import type { ConsumptionRecord } from "../types/usms.js";
import { calculateCost, ELECTRICITY_TARIFF, WATER_TARIFF } from "../utils/tariff.js";

interface SummaryStatsProps {
  records: ConsumptionRecord[];
  unitLabel: string;
  meterType: "electricity" | "water";
}

interface StatCellProps {
  value: string;
  valueSuffix?: string;
  label: string;
  sub?: string;
  isLast?: boolean;
  /** When true, the first token of `value` ("BND") renders dimmer than the number. */
  isCost?: boolean;
  /** When true, adds a left border accent to anchor the eye */
  isFirst?: boolean;
}

function StatCell({ value, valueSuffix, label, sub, isLast, isCost, isFirst }: StatCellProps) {
  // For cost cells, split "BND 101.51" → currency part + number part
  let currencyNode: React.ReactNode = null;
  let displayValue = value;

  if (isCost && value.startsWith("BND ")) {
    const num = value.slice(4);
    currencyNode = (
      <span
        className="font-mono font-normal mr-1"
        style={{ color: "var(--text-tertiary)", fontSize: "14px", alignSelf: "baseline" }}
      >
        BND
      </span>
    );
    displayValue = num;
  }

  return (
    <div
      className="flex-1 min-w-0 px-4 first:pl-0"
      style={{
        borderRight: isLast ? "none" : "1px solid var(--border-subtle)",
        borderLeft: isFirst ? "2px solid rgba(217, 165, 80, 0.30)" : undefined,
        paddingLeft: isFirst ? "12px" : undefined,
      }}
    >
      {/* Label above the value */}
      <p
        className="font-sans font-medium uppercase mb-1.5"
        style={{
          color: "var(--text-tertiary)",
          fontSize: "11px",
          letterSpacing: "0.12em",
        }}
      >
        {label}
      </p>
      <div className="flex items-baseline gap-1">
        {currencyNode}
        <span
          className="font-mono font-bold leading-none"
          style={{ color: "var(--text-primary)", fontSize: "26px" }}
        >
          {displayValue}
        </span>
        {valueSuffix && (
          <span
            className="font-mono font-normal"
            style={{ color: "var(--text-secondary)", fontSize: "13px" }}
          >
            {valueSuffix}
          </span>
        )}
      </div>
      {sub && (
        <p className="font-mono mt-1" style={{ color: "var(--text-tertiary)", fontSize: "11px" }}>
          {sub}
        </p>
      )}
    </div>
  );
}

/** Format YYYY-MM-DD as "6 Apr" */
function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

export function SummaryStats({ records, unitLabel, meterType }: SummaryStatsProps) {
  if (records.length === 0) return null;

  const tariff = meterType === "electricity" ? ELECTRICITY_TARIFF : WATER_TARIFF;
  const safe   = records.map((r) => ({ ...r, consumption: Number(r.consumption) || 0 }));

  const totalConsumption = safe.reduce((s, r) => s + r.consumption, 0);
  const totalCost        = calculateCost(totalConsumption, tariff);
  const dayCount         = safe.length;
  const avgDaily         = dayCount > 0 ? totalConsumption / dayCount : 0;

  const peakRecord = safe.reduce(
    (max, r) => (r.consumption > max.consumption ? r : max),
    safe[0]
  );

  return (
    <div className="flex flex-wrap">
      {/* On small screens: 2-col grid */}
      <div className="w-full grid grid-cols-2 gap-y-6 sm:hidden">
        <StatCell
          value={totalConsumption.toFixed(1)}
          valueSuffix={unitLabel}
          label="Total"
          sub={`${dayCount} days`}
          isFirst
        />
        <StatCell
          value={`BND ${totalCost.toFixed(2)}`}
          label="Total cost"
          sub={`${dayCount} days`}
          isLast
          isCost
        />
        <StatCell
          value={avgDaily.toFixed(2)}
          valueSuffix={`${unitLabel}/day`}
          label="Daily avg"
        />
        <StatCell
          value={peakRecord.consumption.toFixed(2)}
          valueSuffix={unitLabel}
          label="Peak day"
          sub={formatDate(peakRecord.period)}
          isLast
        />
      </div>

      {/* On sm+ screens: horizontal row */}
      <div className="hidden sm:flex w-full">
        <StatCell
          value={totalConsumption.toFixed(1)}
          valueSuffix={unitLabel}
          label="Total"
          sub={`${dayCount} days`}
          isFirst
        />
        <StatCell
          value={`BND ${totalCost.toFixed(2)}`}
          label="Total cost"
          sub={`${dayCount} days`}
          isCost
        />
        <StatCell
          value={avgDaily.toFixed(2)}
          valueSuffix={`${unitLabel}/day`}
          label="Daily avg"
        />
        <StatCell
          value={peakRecord.consumption.toFixed(2)}
          valueSuffix={unitLabel}
          label="Peak day"
          sub={formatDate(peakRecord.period)}
          isLast
        />
      </div>
    </div>
  );
}
