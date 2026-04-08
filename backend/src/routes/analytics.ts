/**
 * Analytics endpoints (read-only, low risk — no scraping).
 *
 * GET  /api/analytics/trend?meterNo=X&period=7d|30d|90d  → TrendAnalysis
 * GET  /api/analytics/forecast?meterNo=X                 → Forecast
 */
import { Router, Request, Response } from "express";
import { computeTrend, type TrendAnalysis } from "../analytics/trend.js";
import { computeForecast } from "../analytics/forecast.js";

export const analyticsRouter = Router();

// ─── Trend ────────────────────────────────────────────────────────────────────

analyticsRouter.get("/trend", (req: Request, res: Response) => {
  const { meterNo, period } = req.query as { meterNo?: string; period?: string };

  if (!meterNo || typeof meterNo !== "string") {
    return res.status(400).json({ error: "meterNo query param is required" });
  }

  const validPeriods: TrendAnalysis["period"][] = ["7d", "30d", "90d"];
  const p = (period ?? "30d") as TrendAnalysis["period"];
  if (!validPeriods.includes(p)) {
    return res.status(400).json({ error: "period must be 7d, 30d, or 90d" });
  }

  try {
    const result = computeTrend(meterNo, p);
    return res.json(result);
  } catch (err) {
    console.error("[analytics/trend]", (err as Error).message);
    return res.status(500).json({ error: "Failed to compute trend analysis" });
  }
});

// ─── Forecast ─────────────────────────────────────────────────────────────────

analyticsRouter.get("/forecast", (req: Request, res: Response) => {
  const { meterNo } = req.query as { meterNo?: string };

  if (!meterNo || typeof meterNo !== "string") {
    return res.status(400).json({ error: "meterNo query param is required" });
  }

  try {
    const result = computeForecast(meterNo);
    return res.json(result);
  } catch (err) {
    console.error("[analytics/forecast]", (err as Error).message);
    return res.status(500).json({ error: "Failed to compute forecast" });
  }
});
