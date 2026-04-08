/**
 * Consumption trend detection.
 *
 * Compares rolling average of the last N days vs the previous N days.
 * Direction thresholds: >5% = "up", <-5% = "down", else "stable".
 *
 * Reads from the daily_consumption normalized table via getDailyConsumption().
 */
import { getDailyConsumption } from "../cache.js";

export interface TrendAnalysis {
  period: "7d" | "30d" | "90d";
  direction: "up" | "down" | "stable";
  changePercent: number;
  currentAvgDaily: number;
  previousAvgDaily: number;
  insight: string;
}

const PERIOD_DAYS: Record<TrendAnalysis["period"], number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

/** Format a date as YYYY-MM-DD, offset by `daysBack` from today. */
function dateOffset(daysBack: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return d.toISOString().slice(0, 10);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function computeTrend(
  meterNo: string,
  period: TrendAnalysis["period"]
): TrendAnalysis {
  const n = PERIOD_DAYS[period];

  // Current window: last N days (ending yesterday to avoid partial today)
  const currentEnd   = dateOffset(1);
  const currentStart = dateOffset(n);
  // Previous window: the N days before that
  const prevEnd   = dateOffset(n + 1);
  const prevStart = dateOffset(n * 2);

  const currentRows = getDailyConsumption(meterNo, currentStart, currentEnd);
  const prevRows    = getDailyConsumption(meterNo, prevStart,    prevEnd);

  const currentAvgDaily = average(currentRows.map((r) => r.consumption));
  const previousAvgDaily = average(prevRows.map((r) => r.consumption));

  let changePercent = 0;
  let direction: TrendAnalysis["direction"] = "stable";

  if (previousAvgDaily > 0) {
    changePercent = ((currentAvgDaily - previousAvgDaily) / previousAvgDaily) * 100;
    if (changePercent > 5) direction = "up";
    else if (changePercent < -5) direction = "down";
  }

  const periodLabel =
    period === "7d" ? "last week" : period === "30d" ? "last month" : "last 3 months";

  let insight: string;
  const absChange = Math.abs(Math.round(changePercent));
  if (direction === "up") {
    insight = `Your daily average increased ${absChange}% vs ${periodLabel}`;
  } else if (direction === "down") {
    insight = `Your daily average decreased ${absChange}% vs ${periodLabel}`;
  } else {
    insight = `Your usage is stable compared to ${periodLabel}`;
  }

  return {
    period,
    direction,
    changePercent: Math.round(changePercent * 10) / 10,
    currentAvgDaily: Math.round(currentAvgDaily * 100) / 100,
    previousAvgDaily: Math.round(previousAvgDaily * 100) / 100,
    insight,
  };
}
