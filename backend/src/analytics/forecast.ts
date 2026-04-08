/**
 * 7-day consumption forecast using Exponential Moving Average (EMA)
 * with day-of-week seasonality adjustment.
 *
 * Algorithm:
 *   1. Fetch last 30 days of daily_consumption for the meter.
 *   2. Compute 14-day EMA as baseline (alpha = 2 / (14 + 1)).
 *   3. Compute day-of-week adjustment factors:
 *      factor[dow] = avg consumption on that DOW / overall avg consumption
 *   4. Forecast next 7 days: EMA_last × factor[dow]
 *   5. Confidence interval: ±1.5 std dev of the 14 most recent days.
 */
import { getDailyConsumption } from "../cache.js";

export interface ForecastDay {
  date: string;      // YYYY-MM-DD
  predicted: number; // kWh (or m³)
  lower: number;     // 80% confidence lower bound
  upper: number;     // 80% confidence upper bound
}

export interface Forecast {
  meterNo: string;
  days: ForecastDay[];
  method: "ema";
  basedOnDays: number;
}

/** Add `n` days to a YYYY-MM-DD string. */
function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Compute EMA over an array, returning the last EMA value. */
function computeEMA(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const alpha = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = alpha * values[i] + (1 - alpha) * ema;
  }
  return ema;
}

/** Standard deviation of an array. */
function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function computeForecast(meterNo: string): Forecast {
  // Fetch last 30 days ending yesterday (avoid partial today)
  const today = new Date().toISOString().slice(0, 10);
  const endDate   = addDays(today, -1);
  const startDate = addDays(today, -30);

  const rows = getDailyConsumption(meterNo, startDate, endDate);
  const basedOnDays = rows.length;

  if (rows.length === 0) {
    // No data — return zeroed forecast
    return {
      meterNo,
      days: Array.from({ length: 7 }, (_, i) => ({
        date: addDays(today, i),
        predicted: 0,
        lower: 0,
        upper: 0,
      })),
      method: "ema",
      basedOnDays: 0,
    };
  }

  const consumptions = rows.map((r) => r.consumption);

  // EMA baseline using up to 14 periods
  const emaPeriod = Math.min(14, consumptions.length);
  const emaWindow = consumptions.slice(-emaPeriod);
  const emaValue  = computeEMA(emaWindow, emaPeriod);

  // Day-of-week factors
  // DOW: 0 = Sunday, 6 = Saturday (matching Date.getUTCDay())
  const dowSums   = new Array(7).fill(0);
  const dowCounts = new Array(7).fill(0);

  for (const row of rows) {
    const dow = new Date(row.date + "T00:00:00Z").getUTCDay();
    dowSums[dow]   += row.consumption;
    dowCounts[dow] += 1;
  }

  const overallAvg = consumptions.reduce((a, b) => a + b, 0) / consumptions.length;
  const dowFactors = dowSums.map((sum, i) => {
    if (dowCounts[i] === 0) return 1; // no data for this DOW → neutral
    const dowAvg = sum / dowCounts[i];
    return overallAvg > 0 ? dowAvg / overallAvg : 1;
  });

  // Confidence: ±1.5 std devs of the most recent 14 days
  const recentWindow = consumptions.slice(-14);
  const sd = stddev(recentWindow);
  const halfInterval = 1.5 * sd;

  // Build 7-day forecast
  const days: ForecastDay[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(today, i);
    const dow  = new Date(date + "T00:00:00Z").getUTCDay();
    const predicted = Math.max(0, emaValue * dowFactors[dow]);
    const lower = Math.max(0, predicted - halfInterval);
    const upper = predicted + halfInterval;
    days.push({
      date,
      predicted: Math.round(predicted * 100) / 100,
      lower:     Math.round(lower     * 100) / 100,
      upper:     Math.round(upper     * 100) / 100,
    });
  }

  return {
    meterNo,
    days,
    method: "ema",
    basedOnDays,
  };
}
