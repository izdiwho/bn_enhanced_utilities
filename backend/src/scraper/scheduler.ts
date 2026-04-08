/**
 * Scheduled scraper using node-cron.
 *
 * - Runs hourly at minute 0 (0 * * * *)
 * - Configurable via SCRAPE_INTERVAL_CRON env var
 * - Manual trigger with 5-minute debounce
 * - Runs on startup if last success > 1 hour ago
 * - Scrape sequence: login → meters → consumption/topups per meter
 * - Log to scrape_log table
 * - Handle errors gracefully with individual meter retry
 */

import cron from "node-cron";
import { ensureSession } from "../session.js";
import { usmsGet } from "./client.js";
import { parseHomePage } from "./mainPage.js";
import { fetchConsumptionHistory, fetchTopUpHistory } from "./reports.js";
import { combineNormalizedData } from "./normalizer.js";
import {
  upsertDailyConsumption,
  upsertTopupTransactions,
  insertMeterSnapshot,
  insertScrapeLog,
  updateScrapeLog,
  getLastSuccessfulScrape,
} from "../cache.js";

export type ScrapeStatus = "idle" | "running";
export type ScrapeTrigger = "schedule" | "manual" | "startup";

interface ScrapeState {
  status: ScrapeStatus;
  lastJobId: number | null;
  lastScrapeAt: number | null;
  lastScrapeStatus: "success" | "error" | null;
}

const CONSUMPTION_MONTHS = parseInt(process.env.SCRAPE_CONSUMPTION_MONTHS ?? "3", 10);
const TOPUP_DAYS = parseInt(process.env.SCRAPE_TOPUP_DAYS ?? "365", 10);
const SCRAPE_INTERVAL_CRON = process.env.SCRAPE_INTERVAL_CRON ?? "0 * * * *";
const SCRAPE_ON_STARTUP = process.env.SCRAPE_ON_STARTUP !== "false";
const MANUAL_TRIGGER_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

let scrapeState: ScrapeState = {
  status: "idle",
  lastJobId: null,
  lastScrapeAt: null,
  lastScrapeStatus: null,
};

let cronTask: cron.ScheduledTask | null = null;
let lastManualTriggerAt = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get per-month date ranges for consumption scraping.
 * Daily data is limited to max 1 month per request.
 * Returns an array of { startDate, endDate } for each month.
 */
function getConsumptionMonthRanges(): { startDate: string; endDate: string }[] {
  const now = new Date();
  const ranges: { startDate: string; endDate: string }[] = [];

  for (let offset = CONSUMPTION_MONTHS - 1; offset >= 0; offset--) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const isCurrentMonth = offset === 0;
    // For current month, end at yesterday (today's data may not be available yet)
    const monthEnd = isCurrentMonth
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
      : new Date(now.getFullYear(), now.getMonth() - offset + 1, 0); // last day of month

    // Skip if start > end (e.g., 1st of the month, yesterday is previous month)
    if (monthStart > monthEnd) continue;

    ranges.push({
      startDate: monthStart.toISOString().slice(0, 10),
      endDate: monthEnd.toISOString().slice(0, 10),
    });
  }

  return ranges;
}

/**
 * Calculates date range for scraping topups (last N days).
 */
function getTopupDateRange(): { startDate: string; endDate: string } {
  const now = new Date();
  const endDate = now;
  const startDate = new Date(now.getTime() - TOPUP_DAYS * 24 * 60 * 60 * 1000);

  const isoStart = startDate.toISOString().slice(0, 10);
  const isoEnd = endDate.toISOString().slice(0, 10);

  return { startDate: isoStart, endDate: isoEnd };
}

// ─── Main scrape job ─────────────────────────────────────────────────────────

async function runScrape(trigger: ScrapeTrigger): Promise<void> {
  if (scrapeState.status === "running") {
    console.log("[scheduler] Scrape already running, skipping");
    return;
  }

  scrapeState.status = "running";
  const startedAt = Date.now();
  let jobId: number | null = null;

  try {
    // Start log entry
    jobId = insertScrapeLog({
      started_at: startedAt,
      status: "running",
      trigger,
    });
    scrapeState.lastJobId = jobId;

    console.log(`[scheduler] Scrape started (trigger: ${trigger}, job: ${jobId})`);

    // Step 1: Ensure session
    const session = await ensureSession();

    // Step 2: Fetch meters from home page
    const homeResult = await usmsGet("/SmartMeter/Home", session.cookies);
    if (homeResult.redirectedToLogin) {
      throw new Error("Session expired during home page fetch");
    }
    const meters = parseHomePage(homeResult.html);
    console.log(`[scheduler] Found ${meters.length} meter(s)`);

    if (meters.length === 0) {
      throw new Error("No meters found on home page");
    }

    // Step 3: Fetch consumption and topups for each meter
    const consumptionByMeter = new Map<string, any[]>();
    const topupsByMeter = new Map<string, any[]>();
    const consumptionMonths = getConsumptionMonthRanges();
    const topupRange = getTopupDateRange();
    let totalConsumptionRecords = 0;
    let totalTopupRecords = 0;

    for (const meter of meters) {
      const sessionToken = "default";
      try {
        // Fetch consumption — one month at a time (daily data limited to 31 days)
        const allRecords: any[] = [];
        for (const monthRange of consumptionMonths) {
          try {
            const result = await fetchConsumptionHistory(
              meter.reportParam,
              monthRange.startDate,
              monthRange.endDate,
              session.cookies,
              sessionToken
            );
            allRecords.push(...result.records);
            console.log(
              `[scheduler] Meter ${meter.meterNo} (${monthRange.startDate}→${monthRange.endDate}): ${result.records.length} records`
            );
          } catch (err) {
            console.warn(
              `[scheduler] Meter ${meter.meterNo} consumption ${monthRange.startDate}→${monthRange.endDate} failed: ${(err as Error).message}`
            );
          }
        }
        consumptionByMeter.set(meter.meterNo, allRecords);
        totalConsumptionRecords += allRecords.length;
        console.log(
          `[scheduler] Meter ${meter.meterNo}: ${allRecords.length} total consumption records`
        );

        // Fetch topups
        const topupResult = await fetchTopUpHistory(
          meter.reportParam,
          topupRange.startDate,
          topupRange.endDate,
          session.cookies,
          sessionToken
        );
        topupsByMeter.set(meter.meterNo, topupResult.records);
        totalTopupRecords += topupResult.records.length;
        console.log(
          `[scheduler] Meter ${meter.meterNo}: ${topupResult.records.length} topup records`
        );
      } catch (err) {
        const msg = (err as Error).message;
        console.error(
          `[scheduler] Failed to fetch data for meter ${meter.meterNo}: ${msg}`
        );
        // Continue with next meter on individual failure
      }
    }

    // Step 4: Normalize and upsert data
    const normalized = combineNormalizedData(
      meters,
      consumptionByMeter,
      topupsByMeter
    );

    if (normalized.consumption.length > 0) {
      upsertDailyConsumption(normalized.consumption);
    }
    if (normalized.topups.length > 0) {
      upsertTopupTransactions(normalized.topups);
    }
    for (const snapshot of normalized.snapshots) {
      insertMeterSnapshot(snapshot);
    }

    console.log(
      `[scheduler] Upserted ${normalized.consumption.length} consumption rows, ${normalized.topups.length} topup rows, ${normalized.snapshots.length} meter snapshots`
    );

    // Step 5: Log success
    const finishedAt = Date.now();
    updateScrapeLog(jobId, {
      finished_at: finishedAt,
      status: "success",
      meters_found: meters.length,
      consumption_records: totalConsumptionRecords,
      topup_records: totalTopupRecords,
    });

    scrapeState.lastScrapeAt = finishedAt;
    scrapeState.lastScrapeStatus = "success";
    console.log(
      `[scheduler] Scrape completed successfully in ${finishedAt - startedAt}ms`
    );
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[scheduler] Scrape failed: ${msg}`);

    if (jobId) {
      updateScrapeLog(jobId, {
        finished_at: Date.now(),
        status: "error",
        error_message: msg,
      });
    }

    scrapeState.lastScrapeStatus = "error";
  } finally {
    scrapeState.status = "idle";
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function getScrapeStatus(): {
  running: boolean;
  lastScrapeAt: number | null;
  lastScrapeStatus: "success" | "error" | null;
} {
  return {
    running: scrapeState.status === "running",
    lastScrapeAt: scrapeState.lastScrapeAt,
    lastScrapeStatus: scrapeState.lastScrapeStatus,
  };
}

export async function triggerScrape(): Promise<void> {
  const now = Date.now();
  if (now - lastManualTriggerAt < MANUAL_TRIGGER_DEBOUNCE_MS) {
    console.log(
      "[scheduler] Manual trigger debounced (too soon after last trigger)"
    );
    return;
  }

  lastManualTriggerAt = now;
  await runScrape("manual");
}

/**
 * Start the scheduler.
 * - Sets up the cron job with SCRAPE_INTERVAL_CRON
 * - Runs on startup if SCRAPE_ON_STARTUP is true and last success > 1 hour ago
 */
export async function startScheduler(): Promise<void> {
  console.log(`[scheduler] Initializing (cron: ${SCRAPE_INTERVAL_CRON})`);

  // Check if we should run on startup
  if (SCRAPE_ON_STARTUP) {
    const lastSuccess = getLastSuccessfulScrape();
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    if (!lastSuccess || !lastSuccess.finished_at || lastSuccess.finished_at < oneHourAgo) {
      console.log("[scheduler] Running scrape on startup (no recent success)");
      await runScrape("startup");
    } else {
      console.log("[scheduler] Skipping startup scrape (recent success found)");
    }
  }

  // Schedule cron job
  cronTask = cron.schedule(SCRAPE_INTERVAL_CRON, () => {
    runScrape("schedule").catch((err) => {
      console.error("[scheduler] Uncaught error in scheduled scrape:", err);
    });
  });

  console.log("[scheduler] Scheduler started");
}

/**
 * Stop the scheduler (for graceful shutdown).
 */
export function stopScheduler(): void {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    console.log("[scheduler] Scheduler stopped");
  }
}
