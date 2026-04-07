/**
 * TariffTierTracker — shows current consumption position within tariff tiers.
 *
 * Displays a horizontal stacked progress bar where each segment represents a
 * tariff tier, with the user's current usage position marked. Includes
 * actionable text: units until next tier, tier jump magnitude, and
 * end-of-month projection.
 */
import type { ConsumptionRecord } from "../types/usms.js";
import {
  ELECTRICITY_TARIFF,
  WATER_TARIFF,
  marginalRate,
  type TariffTier,
} from "../utils/tariff.js";

interface TariffTierTrackerProps {
  records: ConsumptionRecord[];
  meterType: "electricity" | "water";
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

/**
 * Determine which tier index a given consumption falls in (0-based).
 */
function currentTierIndex(consumption: number, tariff: TariffTier[]): number {
  let prev = 0;
  for (let i = 0; i < tariff.length; i++) {
    if (consumption <= tariff[i].upTo) return i;
    prev = tariff[i].upTo;
  }
  return tariff.length - 1;
}

/**
 * Calculate tier lower bound (exclusive).
 */
function tierLowerBound(index: number, tariff: TariffTier[]): number {
  if (index === 0) return 0;
  return tariff[index - 1].upTo;
}

/**
 * Format a rate multiplier: e.g. 8.0 → "8×"
 */
function formatMultiplier(nextRate: number, currentRate: number): string {
  if (currentRate <= 0) return "";
  const mult = nextRate / currentRate;
  return `${mult % 1 === 0 ? mult.toFixed(0) : mult.toFixed(1)}×`;
}

/**
 * How to size each tier segment in the bar.
 * Uses square-root scaling so the first large tier doesn't dominate visually.
 */
function tierWidthPercents(tariff: TariffTier[]): number[] {
  const sizes: number[] = [];
  let prev = 0;
  for (const tier of tariff) {
    const cap = tier.upTo === Infinity ? prev * 0.5 || 200 : tier.upTo - prev;
    sizes.push(Math.sqrt(cap));
    prev = tier.upTo === Infinity ? prev : tier.upTo;
  }
  const total = sizes.reduce((a, b) => a + b, 0);
  return sizes.map((s) => (s / total) * 100);
}

/**
 * For a given consumption and tariff, determine the fill fraction within
 * each tier segment [0, 1].
 */
function tierFillFractions(consumption: number, tariff: TariffTier[]): number[] {
  const fractions: number[] = [];
  let prev = 0;
  let remaining = consumption;

  for (const tier of tariff) {
    const tierCap = tier.upTo === Infinity ? prev * 0.5 || 200 : tier.upTo - prev;
    const inTier = Math.min(remaining, tierCap);
    fractions.push(tierCap > 0 ? inTier / tierCap : 0);
    remaining -= inTier;
    prev = tier.upTo === Infinity ? prev : tier.upTo;
  }
  return fractions;
}

/**
 * Format a consumption number with appropriate precision and unit.
 */
function fmt(n: number, unit: string): string {
  if (n >= 1000) return `${(n / 1000).toFixed(2)}k ${unit}`;
  return `${n % 1 === 0 ? n.toFixed(0) : n.toFixed(1)} ${unit}`;
}

export function TariffTierTracker({ records, meterType }: TariffTierTrackerProps) {
  const tariff = meterType === "electricity" ? ELECTRICITY_TARIFF : WATER_TARIFF;
  const unit = meterType === "electricity" ? "kWh" : "m³";

  if (records.length === 0) {
    return (
      <div>
        <SectionHeader>Tariff Tier</SectionHeader>
        <p className="font-sans text-sm" style={{ color: "var(--text-tertiary)" }}>
          No data to analyse.
        </p>
      </div>
    );
  }

  // Determine the month for current records (use most recent period)
  const sorted = [...records].sort((a, b) => a.period.localeCompare(b.period));
  const latestPeriod = sorted[sorted.length - 1].period;
  const currentMonth = latestPeriod.slice(0, 7); // "YYYY-MM"

  // Sum only current-month records for tariff position
  const currentMonthRecords = records.filter((r) => r.period.startsWith(currentMonth));
  const totalConsumption = currentMonthRecords.reduce((s, r) => s + r.consumption, 0);

  // Current tariff position
  const currentRate = marginalRate(totalConsumption, tariff);
  const tierIdx = currentTierIndex(totalConsumption, tariff);
  const isInLastTier = tierIdx === tariff.length - 1;
  const nextTier = isInLastTier ? null : tariff[tierIdx + 1];
  const currentTierUpperBound = tariff[tierIdx].upTo;
  const unitsUntilNextTier =
    !isInLastTier && currentTierUpperBound !== Infinity
      ? currentTierUpperBound - totalConsumption
      : null;

  // End-of-month projection
  const daysWithData = currentMonthRecords.length;
  const today = new Date();
  const daysInCurrentMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const avgDailyConsumption = daysWithData > 0 ? totalConsumption / daysWithData : 0;
  const projectedMonthly = avgDailyConsumption * daysInCurrentMonth;
  const projectedTierIdx = currentTierIndex(projectedMonthly, tariff);
  const tierNames = meterType === "electricity"
    ? ["Tier 1 (economy)", "Tier 2 (standard)", "Tier 3 (peak)"]
    : ["Tier 1 (base)", "Tier 2 (standard)", "Tier 3 (peak)"];

  // Bar geometry
  const widthPcts = tierWidthPercents(tariff);
  const fillFractions = tierFillFractions(totalConsumption, tariff);

  // Where exactly is the usage indicator line (0–100% of the full bar width)?
  let indicatorPct = 0;
  {
    let usedWidth = 0;
    let prev = 0;
    for (let i = 0; i < tariff.length; i++) {
      const tierCap = tariff[i].upTo === Infinity ? prev * 0.5 || 200 : tariff[i].upTo - prev;
      const inTier = Math.min(Math.max(0, totalConsumption - prev), tierCap);
      usedWidth += (inTier / tierCap) * widthPcts[i];
      prev = tariff[i].upTo === Infinity ? prev : tariff[i].upTo;
    }
    indicatorPct = Math.min(99.5, usedWidth);
  }

  return (
    <div>
      <SectionHeader>Tariff Tier</SectionHeader>

      {/* Stacked tier bar */}
      <div className="relative mb-5" style={{ height: "24px" }}>
        {/* Bar track — flex row of tier segments */}
        <div
          className="flex w-full overflow-hidden"
          style={{ height: "4px", borderRadius: "2px", marginTop: "10px" }}
        >
          {tariff.map((tier, i) => {
            const fill = fillFractions[i];
            return (
              <div
                key={i}
                style={{
                  width: `${widthPcts[i]}%`,
                  position: "relative",
                  background: "var(--bg-raised)",
                  // Thin gap between segments
                  borderRight: i < tariff.length - 1 ? "2px solid var(--bg-deep)" : "none",
                }}
              >
                {/* Filled portion */}
                {fill > 0 && (
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: `${fill * 100}%`,
                      background: "var(--accent-primary)",
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Tier rate labels — below bar */}
        <div className="flex w-full" style={{ marginTop: "6px" }}>
          {tariff.map((tier, i) => (
            <div
              key={i}
              style={{
                width: `${widthPcts[i]}%`,
                overflow: "hidden",
              }}
            >
              <span
                className="font-mono"
                style={{
                  fontSize: "10px",
                  color: i === tierIdx ? "var(--accent-primary)" : "var(--text-tertiary)",
                  whiteSpace: "nowrap",
                }}
              >
                {tier.rate.toFixed(2)}/{unit === "kWh" ? "kWh" : "m³"}
              </span>
            </div>
          ))}
        </div>

        {/* Usage indicator — vertical line + label */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: `${indicatorPct}%`,
            transform: "translateX(-50%)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            pointerEvents: "none",
          }}
        >
          {/* Triangle pointer */}
          <div
            style={{
              width: 0,
              height: 0,
              borderLeft: "5px solid transparent",
              borderRight: "5px solid transparent",
              borderTop: "8px solid var(--accent-primary)",
              marginBottom: "1px",
            }}
          />
          {/* 4px-tall indicator line */}
          <div
            style={{
              width: "2px",
              height: "4px",
              background: "var(--accent-primary)",
            }}
          />
        </div>
      </div>

      {/* Current position label */}
      <p
        className="font-sans text-xs mb-1"
        style={{ color: "var(--text-secondary)" }}
      >
        You've used{" "}
        <span className="font-mono font-semibold" style={{ color: "var(--text-primary)" }}>
          {fmt(totalConsumption, unit)}
        </span>{" "}
        at{" "}
        <span className="font-mono" style={{ color: "var(--accent-primary)" }}>
          BND {currentRate.toFixed(2)}/{unit}
        </span>
      </p>

      {/* Next tier warning */}
      {unitsUntilNextTier !== null && nextTier && (
        <p
          className="font-sans text-xs mb-1"
          style={{ color: "var(--text-tertiary)" }}
        >
          <span className="font-mono font-semibold" style={{ color: "var(--text-secondary)", fontSize: "14px" }}>
            {fmt(unitsUntilNextTier, unit)}
          </span>{" "}
          until tier {tierIdx + 2} —{" "}
          <span className="font-mono" style={{ color: "var(--accent-primary)" }}>
            BND {currentRate.toFixed(2)} → {nextTier.rate.toFixed(2)}
          </span>
          {currentRate > 0 && (
            <span
              className="font-mono ml-1"
              style={{
                background: "rgba(204, 92, 92, 0.12)",
                color: "var(--color-holiday)",
                padding: "1px 4px",
                borderRadius: "2px",
              }}
            >
              {formatMultiplier(nextTier.rate, currentRate)} jump
            </span>
          )}
        </p>
      )}

      {isInLastTier && (
        <p
          className="font-sans text-xs mb-1"
          style={{ color: "var(--text-tertiary)" }}
        >
          You're in the top tier —{" "}
          <span className="font-mono" style={{ color: "var(--accent-primary)" }}>
            BND {currentRate.toFixed(2)}/{unit}
          </span>{" "}
          on all additional usage.
        </p>
      )}

      {/* Projection */}
      {daysWithData > 0 && avgDailyConsumption > 0 && (
        <p
          className="font-sans text-xs mt-2"
          style={{ color: "var(--text-tertiary)" }}
        >
          Projected:{" "}
          <span className="font-mono" style={{ color: "var(--text-secondary)" }}>
            ~{fmt(projectedMonthly, unit)}
          </span>{" "}
          this month →{" "}
          <span
            style={{
              color: projectedTierIdx > tierIdx ? "var(--accent-primary)" : "var(--text-secondary)",
            }}
          >
            {tierNames[projectedTierIdx]}
          </span>
        </p>
      )}

      {/* Tier legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3">
        {tariff.map((tier, i) => {
          const lower = tierLowerBound(i, tariff);
          const upper = tier.upTo === Infinity ? "∞" : tier.upTo.toLocaleString();
          return (
            <span
              key={i}
              className="font-sans"
              style={{
                fontSize: "10px",
                color: i === tierIdx ? "var(--text-secondary)" : "var(--text-tertiary)",
              }}
            >
              T{i + 1}:{" "}
              <span className="font-mono">
                {lower.toLocaleString()}–{upper} {unit}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
