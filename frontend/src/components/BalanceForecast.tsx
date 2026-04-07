/**
 * BalanceForecast — projects when the current balance will run out.
 *
 * Kampong Grid styling:
 * - Depletion date: very large font-mono (28px), bright --text-primary — the hero number
 * - Context in font-sans --text-secondary
 * - 2px height progress bar (thinner)
 * - Compact — no padding, no card
 *
 * Algorithm:
 *  1. Average monthly consumption from daily history.
 *  2. Apply tiered tariff to get estimated monthly cost.
 *  3. Divide current balance by monthly cost → months remaining.
 *  4. Add months to today → depletion date.
 *
 * Confidence band derived from consumption standard deviation.
 */
import { useState, useEffect } from "react";
import type { Meter, ConsumptionRecord, TopUpRecord } from "../types/usms.js";
import {
  calculateCost,
  estimateMonthsRemaining,
  ELECTRICITY_TARIFF,
  WATER_TARIFF,
} from "../utils/tariff.js";
import { getTopupHistory } from "../api/usms.js";

interface BalanceForecastProps {
  meter: Meter;
  consumptionRecords: ConsumptionRecord[];
  refreshKey?: number;
}

function addMonthsToDate(date: Date, months: number): Date {
  const d = new Date(date);
  d.setDate(1); // avoid day-of-month overflow
  d.setMonth(d.getMonth() + Math.floor(months));
  // fractional part → days
  const fracDays = (months % 1) * 30;
  d.setDate(d.getDate() + Math.round(fracDays));
  return d;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-BN", { day: "numeric", month: "short", year: "numeric" });
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length;
  return Math.sqrt(variance);
}

function getDefaultTopupRange(): { startDate: string; endDate: string } {
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - 179);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { startDate: fmt(start), endDate: fmt(today) };
}

export function BalanceForecast({
  meter,
  consumptionRecords,
  refreshKey,
}: BalanceForecastProps) {
  const [topupRecords, setTopupRecords] = useState<TopUpRecord[]>([]);
  const [topupLoading, setTopupLoading] = useState(false);
  const [topupError, setTopupError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setTopupLoading(true);
      setTopupError(null);
      try {
        const { startDate, endDate } = getDefaultTopupRange();
        const res = await getTopupHistory(meter.meterNo, startDate, endDate);
        if (!cancelled) setTopupRecords(res.records);
      } catch {
        if (cancelled) return;
        setTopupError("Could not load top-up history.");
      } finally {
        if (!cancelled) setTopupLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [meter.meterNo, refreshKey]);

  const tariff = meter.meterType === "electricity" ? ELECTRICITY_TARIFF : WATER_TARIFF;

  const chronological = [...consumptionRecords].sort((a, b) =>
    a.period.localeCompare(b.period)
  );

  const avgDailyConsumption =
    chronological.length > 0
      ? chronological.reduce((s, r) => s + r.consumption, 0) / chronological.length
      : 0;

  const avgMonthlyConsumption = avgDailyConsumption * 30;

  const monthsRemaining = estimateMonthsRemaining(
    meter.remainingBalance,
    avgMonthlyConsumption,
    tariff
  );

  const monthlyCost = calculateCost(avgMonthlyConsumption, tariff);

  const now = new Date();
  const depletionDate =
    monthsRemaining !== Infinity ? addMonthsToDate(now, monthsRemaining) : null;

  // Confidence band
  const sd = stdDev(chronological.map((r) => r.consumption)) * 30;
  const optimisticConsumption = Math.max(0.1, avgMonthlyConsumption - sd);
  const pessimisticConsumption = avgMonthlyConsumption + sd;
  const optimisticMonths = estimateMonthsRemaining(
    meter.remainingBalance,
    optimisticConsumption,
    tariff
  );
  const pessimisticMonths = estimateMonthsRemaining(
    meter.remainingBalance,
    pessimisticConsumption,
    tariff
  );
  const optimisticDate = optimisticMonths !== Infinity ? addMonthsToDate(now, optimisticMonths) : null;
  const pessimisticDate = pessimisticMonths !== Infinity ? addMonthsToDate(now, pessimisticMonths) : null;

  // Last top-up
  const sortedTopups = [...topupRecords].sort((a, b) =>
    b.topupDate.localeCompare(a.topupDate)
  );
  const lastTopup = sortedTopups[0] ?? null;

  // Timeline bar
  const topupAmount = lastTopup?.actualRechargeAmount ?? 0;
  const balanceUsedPct =
    topupAmount > 0
      ? Math.min(100, Math.max(0, ((topupAmount - meter.remainingBalance) / topupAmount) * 100))
      : null;

  const unitLabel = meter.remainingUnitLabel;
  const noData = avgMonthlyConsumption <= 0 || consumptionRecords.length === 0;

  return (
    <div>
      <p
        className="font-sans font-medium uppercase mb-3"
        style={{
          color: "var(--text-tertiary)",
          fontSize: "11px",
          letterSpacing: "0.12em",
        }}
      >
        Balance Forecast
      </p>

      {noData ? (
        <p className="font-sans text-sm" style={{ color: "var(--text-tertiary)" }}>
          Not enough consumption history to generate a forecast.
        </p>
      ) : (
        <div className="space-y-3">
          {/* Depletion date — hero element, large and bright */}
          {depletionDate ? (
            <div>
              <p
                className="font-mono font-semibold leading-none mb-1"
                style={{
                  color: monthsRemaining < 1 ? "var(--color-holiday)" : "var(--accent-primary)",
                  fontSize: "28px",
                }}
              >
                ~{formatDate(depletionDate)}
              </p>
              <p className="font-sans text-xs mb-1" style={{ color: "var(--text-secondary)" }}>
                estimated depletion
              </p>
              <p className="font-sans text-xs" style={{ color: "var(--text-tertiary)" }}>
                <span className="font-mono" style={{ color: "var(--text-secondary)" }}>{monthsRemaining.toFixed(1)}</span> months at{" "}
                <span className="font-mono">{avgDailyConsumption.toFixed(1)}</span> {unitLabel}/day ≈{" "}
                <span className="font-mono">BND {monthlyCost.toFixed(2)}</span>/mo
              </p>
              {optimisticDate && pessimisticDate && sd > 0 && (
                <p className="font-sans text-xs mt-1" style={{ color: "var(--text-tertiary)" }}>
                  Range:{" "}
                  <span className="font-mono">{formatDate(pessimisticDate)}</span>
                  {" – "}
                  <span className="font-mono">{formatDate(optimisticDate)}</span>
                  {lastTopup && (
                    <span className="ml-2">
                      · Last top-up:{" "}
                      <span className="font-mono">
                        {new Date(lastTopup.topupDate).toLocaleDateString("en-BN", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </span>{" "}
                      (<span className="font-mono">BND {lastTopup.actualRechargeAmount.toFixed(2)}</span>)
                    </span>
                  )}
                </p>
              )}
            </div>
          ) : (
            <p className="font-sans text-sm" style={{ color: "var(--text-tertiary)" }}>
              Balance duration indeterminate (zero or near-zero consumption).
            </p>
          )}

          {/* Timeline bar — 2px height, thinner */}
          {balanceUsedPct !== null && (
            <div className="space-y-1 mt-3">
              <div
                className="w-full rounded-full overflow-hidden"
                style={{ background: "var(--bg-raised)", height: "2px" }}
              >
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${balanceUsedPct}%`,
                    background: "var(--accent-primary)",
                  }}
                />
              </div>
              <div className="flex justify-between" style={{ color: "var(--text-tertiary)" }}>
                <span className="font-mono" style={{ fontSize: "11px" }}>
                  {balanceUsedPct.toFixed(0)}% used
                </span>
                <span className="font-mono" style={{ fontSize: "11px" }}>
                  BND {meter.remainingBalance.toFixed(2)} · {meter.remainingUnit.toFixed(2)} {unitLabel} remaining
                </span>
              </div>
            </div>
          )}

          {/* Fallback balance info when no top-up bar */}
          {balanceUsedPct === null && (
            <div className="flex gap-6">
              <span className="font-sans text-xs" style={{ color: "var(--text-tertiary)" }}>
                Balance:{" "}
                <span className="font-mono" style={{ color: "var(--text-secondary)" }}>
                  BND {meter.remainingBalance.toFixed(2)}
                </span>
              </span>
              <span className="font-sans text-xs" style={{ color: "var(--text-tertiary)" }}>
                Remaining:{" "}
                <span className="font-mono" style={{ color: "var(--text-secondary)" }}>
                  {meter.remainingUnit.toFixed(2)} {unitLabel}
                </span>
              </span>
            </div>
          )}

          {topupLoading && (
            <p className="font-sans text-xs animate-pulse" style={{ color: "var(--text-tertiary)" }}>
              Loading top-up history...
            </p>
          )}
          {topupError && (
            <p className="font-sans text-xs" style={{ color: "var(--accent-primary)" }}>{topupError}</p>
          )}
        </div>
      )}
    </div>
  );
}
