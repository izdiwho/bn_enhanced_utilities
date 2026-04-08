/**
 * Data normalizer — transforms raw scrape output into normalized database rows.
 *
 * Ingests:
 *   - ConsumptionRecord[] (from fetchConsumptionHistory)
 *   - TopUpRecord[] (from fetchTopUpHistory)
 *   - Meter[] (from parseHomePage)
 *
 * Outputs normalized rows for:
 *   - daily_consumption
 *   - topup_transactions
 *   - meter_snapshots
 */

import type { ConsumptionRecord, TopUpRecord } from "./reports.js";
import type { Meter } from "./mainPage.js";
import type {
  DailyConsumptionRow,
  TopupTransactionRow,
  MeterSnapshotRow,
} from "../cache.js";

export interface NormalizedData {
  consumption: DailyConsumptionRow[];
  topups: TopupTransactionRow[];
  snapshots: MeterSnapshotRow[];
}

const now = Date.now();

/**
 * Normalize consumption records into daily_consumption rows.
 *
 * ConsumptionRecord.period is in "YYYY-MM-DD" format (daily data).
 */
export function normalizeConsumption(
  records: ConsumptionRecord[],
  meterNo: string,
  unit: string
): DailyConsumptionRow[] {
  return records.map((r) => ({
    meter_no: meterNo,
    date: r.period, // Already YYYY-MM-DD
    consumption: r.consumption,
    unit,
    scraped_at: now,
  }));
}

/**
 * Normalize topup records into topup_transactions rows.
 * Deduplicates by transaction_no.
 */
export function normalizeTopups(
  records: TopUpRecord[]
): TopupTransactionRow[] {
  const seen = new Set<string>();
  const deduplicated: TopupTransactionRow[] = [];

  for (const r of records) {
    if (seen.has(r.transactionNo)) continue;
    seen.add(r.transactionNo);

    deduplicated.push({
      transaction_no: r.transactionNo,
      meter_no: r.meterNo,
      topup_date: r.topupDate, // Already YYYY-MM-DD
      topup_amount: r.topupAmount,
      debt_cleared: r.initialLoanDebtCleared,
      recharge_amount: r.actualRechargeAmount,
      units_credited: r.unitsCredited,
      payment_mode: r.paymentMode,
      site_name: r.siteName,
      source: r.source,
      scraped_at: now,
    });
  }

  return deduplicated;
}

/**
 * Normalize meters into meter_snapshots rows.
 * Each meter becomes a snapshot capturing the current balance and unit state.
 */
export function normalizeMeters(meters: Meter[]): MeterSnapshotRow[] {
  return meters.map((m) => ({
    meter_no: m.meterNo,
    meter_type: m.meterType,
    status: m.status,
    balance: m.remainingBalance,
    remaining_unit: m.remainingUnit,
    unit_label: m.remainingUnitLabel,
    full_name: m.fullName,
    address: m.address,
    last_updated: m.lastUpdated,
    scraped_at: now,
  }));
}

/**
 * Combine all normalized data from a complete scrape run.
 */
export function combineNormalizedData(
  meters: Meter[],
  consumptionByMeter: Map<string, ConsumptionRecord[]>,
  topupsByMeter: Map<string, TopUpRecord[]>
): NormalizedData {
  const consumption: DailyConsumptionRow[] = [];
  const topups: TopupTransactionRow[] = [];
  const snapshots = normalizeMeters(meters);

  for (const meter of meters) {
    const consumptionRecords = consumptionByMeter.get(meter.meterNo) ?? [];
    const topupRecords = topupsByMeter.get(meter.meterNo) ?? [];

    consumption.push(
      ...normalizeConsumption(consumptionRecords, meter.meterNo, meter.remainingUnitLabel)
    );
    topups.push(...normalizeTopups(topupRecords));
  }

  return { consumption, topups, snapshots };
}
