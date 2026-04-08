/**
 * Enhanced Utilities Tracker — Express backend entry point.
 *
 * Mounts:
 *   /api/config    → auth.ts  (meter list + feature flags)
 *   /api/*         → usms.ts  (data endpoints, no auth token needed)
 *   /api/ai/*      → ai.ts    (gated on OPENROUTER_API_KEY)
 *
 * CORS is open (allow all origins) — this is a single-user local tool.
 * Credentials come from USMS_IC + USMS_PASSWORD env vars, not from the client.
 */
import express from "express";
import cors from "cors";
import { authRouter } from "./routes/auth.js";
import { usmsRouter } from "./routes/usms.js";
import { aiRouter } from "./routes/ai.js";
import { pinRouter, pinGuard } from "./routes/pin.js";
import { scrapeRouter } from "./routes/scrape.js";
import { analyticsRouter } from "./routes/analytics.js";
import { getDb } from "./cache.js";
import { browserScraper } from "./scraper/browser.js";
import { startScheduler, stopScheduler } from "./scraper/scheduler.js";

const PORT = parseInt(process.env.PORT ?? "4000", 10);

const app = express();

// ─── Middleware ──────────────────────────────────────────────────────────────

// Restrict to frontend origin (configurable for non-Docker setups).
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:3002";
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json({ limit: "64kb" }));

// ─── PIN auth (before data routes) ───────────────────────────────────────────

// /api/pin/verify and /api/pin/status are public (rate-limited internally)
app.use("/api/pin", pinRouter);

// All other /api/* routes require a valid PIN (if APP_PIN is set)
app.use("/api", pinGuard);

// ─── Routes ──────────────────────────────────────────────────────────────────

app.use("/api", authRouter);
app.use("/api", usmsRouter);
app.use("/api", scrapeRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/ai", aiRouter);

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────

// Initialise SQLite (runs schema migrations)
getDb();

app.listen(PORT, async () => {
  console.log(`[backend] Listening on port ${PORT}`);
  if (!process.env.USMS_IC) {
    console.warn("[backend] WARNING: USMS_IC is not set. Set USMS_IC and USMS_PASSWORD in .env.");
  } else {
    console.log("[backend] SmartMeter account configured");
  }
  console.log(`[backend] PIN protection: ${process.env.APP_PIN ? "enabled" : "disabled"}`);
  const hasAi = Boolean(process.env.AI_API_KEY || process.env.OPENROUTER_API_KEY);
  console.log(`[backend] AI features: ${hasAi ? "enabled" : "disabled (set AI_API_KEY)"}`);

  // Start the scraper scheduler
  try {
    await startScheduler();
  } catch (err) {
    console.error("[backend] Failed to start scheduler:", err);
  }
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  stopScheduler();
  await browserScraper.cleanup();
  process.exit(0);
});

process.on("SIGINT", async () => {
  stopScheduler();
  await browserScraper.cleanup();
  process.exit(0);
});
