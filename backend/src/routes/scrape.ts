/**
 * Scraper control endpoints.
 *
 * POST /api/scrape/trigger     — Manually trigger a scrape (debounced)
 * GET  /api/scrape/status      — Get current scrape status + last scrape info
 *
 * Both endpoints are protected by pinGuard (if APP_PIN is set).
 */

import { Router, Request, Response } from "express";
import { triggerScrape, getScrapeStatus, type ScrapeStatus } from "../scraper/scheduler.js";
import { getLastScrapeLog } from "../cache.js";

export const scrapeRouter = Router();

// ─── Manual trigger ──────────────────────────────────────────────────────────

scrapeRouter.post("/scrape/trigger", async (_req: Request, res: Response) => {
  try {
    await triggerScrape();
    const status = getScrapeStatus();
    return res.json({
      ok: true,
      running: status.running,
      message: "Scrape triggered",
    });
  } catch (err) {
    console.error("[scrape/trigger]", (err as Error).message);
    return res.status(500).json({ error: "Failed to trigger scrape" });
  }
});

// ─── Status ──────────────────────────────────────────────────────────────────

scrapeRouter.get("/scrape/status", (_req: Request, res: Response) => {
  try {
    const status = getScrapeStatus();
    const lastLog = getLastScrapeLog();

    return res.json({
      running: status.running,
      lastScrape: lastLog
        ? {
            jobId: lastLog.id,
            trigger: lastLog.trigger,
            status: lastLog.status,
            startedAt: lastLog.started_at,
            finishedAt: lastLog.finished_at,
            metersFound: lastLog.meters_found,
            consumptionRecords: lastLog.consumption_records,
            topupRecords: lastLog.topup_records,
            errorMessage: lastLog.error_message,
          }
        : null,
    });
  } catch (err) {
    console.error("[scrape/status]", (err as Error).message);
    return res.status(500).json({ error: "Failed to fetch scrape status" });
  }
});
