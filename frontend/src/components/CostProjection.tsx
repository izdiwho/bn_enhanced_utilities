/**
 * CostProjection — monthly cost pace tracker.
 *
 * Kampong Grid styling:
 * - "BND" prefix rendered slightly dimmer, number in large font-mono (28px semibold), bright
 * - "projected this month" in small font-sans --text-secondary below
 * - 2px progress bar (thinner)
 * - All numeric values in font-mono
 */
import type { ConsumptionRecord } from "../types/usms.js";
import type { ConsumptionDateRange } from "./DateRangePicker.js";
import { calculateCost, ELECTRICITY_TARIFF, WATER_TARIFF } from "../utils/tariff.js";

interface CostProjectionProps {
  records: ConsumptionRecord[];
  meterType: "electricity" | "water";
  dateRange: ConsumptionDateRange;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Renders a large BND cost value with dimmer currency prefix */
function CostHeadline({ amount }: { amount: string }) {
  return (
    <div className="flex items-baseline gap-1 mb-1">
      <span
        className="font-mono font-normal"
        style={{ color: "var(--text-tertiary)", fontSize: "14px" }}
      >
        BND
      </span>
      <span
        className="font-mono font-semibold leading-none"
        style={{ color: "var(--text-primary)", fontSize: "28px" }}
      >
        {amount}
      </span>
    </div>
  );
}

export function CostProjection({ records, meterType, dateRange }: CostProjectionProps) {
  if (records.length === 0) {
    return (
      <div>
        <SectionHeader>Cost Projection</SectionHeader>
        <p className="font-sans text-sm" style={{ color: "var(--text-tertiary)" }}>No consumption data loaded.</p>
      </div>
    );
  }

  const tariff = meterType === "electricity" ? ELECTRICITY_TARIFF : WATER_TARIFF;
  const today = todayIso();

  const nowYear  = new Date().getFullYear();
  const nowMonth = new Date().getMonth() + 1;
  const currentMonthPrefix = `${nowYear}-${String(nowMonth).padStart(2, "0")}`;

  const isCurrentMonth =
    dateRange.preset !== "last3Months" &&
    dateRange.startDate.startsWith(currentMonthPrefix);

  const totalKwh = records.reduce((s, r) => s + r.consumption, 0);

  if (dateRange.preset === "last3Months") {
    const byMonth = new Map<string, number>();
    for (const r of records) {
      const m = r.period.slice(0, 7);
      byMonth.set(m, (byMonth.get(m) ?? 0) + r.consumption);
    }
    const monthlyKwhs = Array.from(byMonth.values());
    const avgMonthly = monthlyKwhs.reduce((a, b) => a + b, 0) / monthlyKwhs.length;
    const avgCost = calculateCost(avgMonthly, tariff);

    return (
      <div>
        <SectionHeader>Cost Projection</SectionHeader>
        <p className="font-sans text-xs mb-3" style={{ color: "var(--text-tertiary)" }}>
          Average over {monthlyKwhs.length} month{monthlyKwhs.length > 1 ? "s" : ""}
        </p>
        <CostHeadline amount={avgCost.toFixed(2)} />
        <p className="font-sans text-xs" style={{ color: "var(--text-secondary)" }}>
          /month avg
        </p>
        <p className="font-sans text-xs mt-2" style={{ color: "var(--text-tertiary)" }}>
          <span className="font-mono">{avgMonthly.toFixed(1)}</span> kWh/month average
        </p>
      </div>
    );
  }

  if (!isCurrentMonth) {
    const actualCost = calculateCost(totalKwh, tariff);
    return (
      <div>
        <SectionHeader>Cost Projection</SectionHeader>
        <p className="font-mono text-xs mb-3" style={{ color: "var(--text-tertiary)" }}>
          {dateRange.startDate} → {dateRange.endDate}
        </p>
        <CostHeadline amount={actualCost.toFixed(2)} />
        <p className="font-sans text-xs" style={{ color: "var(--text-secondary)" }}>
          total
        </p>
        <p className="font-sans text-xs mt-2" style={{ color: "var(--text-tertiary)" }}>
          <span className="font-mono">{totalKwh.toFixed(1)}</span> kWh consumed
        </p>
      </div>
    );
  }

  // Current month — pace calculation
  const startOfMonth = `${currentMonthPrefix}-01`;
  const dayCount = daysInMonth(nowYear, nowMonth);

  const daysElapsed = Math.max(
    1,
    Math.round(
      (new Date(today + "T00:00:00").getTime() - new Date(startOfMonth + "T00:00:00").getTime()) /
        (24 * 60 * 60 * 1000)
    ) + 1
  );
  const daysRemaining = dayCount - daysElapsed;

  const dailyAvg = totalKwh / records.length;
  const projectedMonthlyKwh = dailyAvg * dayCount;
  const projectedCost = calculateCost(projectedMonthlyKwh, tariff);
  const costSoFar = calculateCost(totalKwh, tariff);

  const elapsedPct = Math.min(100, (daysElapsed / dayCount) * 100);

  return (
    <div>
      <SectionHeader>Cost Projection</SectionHeader>

      {/* Projected cost headline — large font-mono with dim BND prefix */}
      <CostHeadline amount={projectedCost.toFixed(2)} />
      <p className="font-sans text-xs mb-2" style={{ color: "var(--text-secondary)" }}>
        projected this month
      </p>
      <p className="font-sans text-xs mb-3" style={{ color: "var(--text-tertiary)" }}>
        <span className="font-mono">{projectedMonthlyKwh.toFixed(1)}</span> kWh at{" "}
        <span className="font-mono">{dailyAvg.toFixed(2)}</span> kWh/day pace
      </p>

      {/* Progress bar — 2px */}
      <div className="space-y-1 mb-3">
        <div
          className="w-full rounded-full overflow-hidden"
          style={{ background: "var(--bg-raised)", height: "2px" }}
        >
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${elapsedPct}%`, background: "var(--accent-primary)" }}
          />
        </div>
        <div className="flex justify-between" style={{ color: "var(--text-tertiary)" }}>
          <span className="font-mono" style={{ fontSize: "11px" }}>
            Day {daysElapsed} of {dayCount}
          </span>
          <span className="font-mono" style={{ fontSize: "11px" }}>
            {daysRemaining} days left
          </span>
        </div>
      </div>

      {/* Spent so far */}
      <p className="font-sans text-xs" style={{ color: "var(--text-tertiary)" }}>
        Spent so far:{" "}
        <span className="font-mono" style={{ color: "var(--text-secondary)" }}>BND {costSoFar.toFixed(2)}</span>
      </p>
    </div>
  );
}

// ─── Shared sub-components ────────────────────────────────────────────────────

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
