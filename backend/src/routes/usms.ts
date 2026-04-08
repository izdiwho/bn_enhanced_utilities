/**
 * Data endpoints — no auth token required (single-user, server-held session).
 *
 * POST /api/account                 — meter list (refreshes from Home if stale)
 * POST /api/meter-details           — { meterNo } → current balance + unit
 * POST /api/consumption-history     — { meterNo, startDate, endDate } (YYYY-MM-DD, max 31 days)
 * POST /api/topup-history           — { meterNo, startDate, endDate }
 *
 * All accept ?force=true to bypass cache.
 * On upstream session expiry (redirect to ResLogin) → auto-re-login once, then retry.
 *
 * Input validation:
 * - meterNo must be in the session's meter list (prevents scraping arbitrary meters)
 * - consumption date range: max 31 days (daily data, portal "Max 1 month" limit)
 * - dates must be valid YYYY-MM-DD
 */
import { Router, Request, Response } from "express";
import { ensureSession, clearSession } from "../session.js";
import {
  getAccountCache, setAccountCache,
  getMeterDetailsCache, setMeterDetailsCache,
  getConsumptionCache, setConsumptionCache,
  getTopupCache, setTopupCache,
  getDailyConsumption,
  getTopupTransactions,
  getLatestMeterSnapshots,
} from "../cache.js";
import { usmsGet } from "../scraper/client.js";
import { parseHomePage, type Meter } from "../scraper/mainPage.js";
import {
  fetchConsumptionHistory,
  fetchTopUpHistory,
} from "../scraper/reports.js";

export const usmsRouter = Router();

function isForced(req: Request): boolean {
  return req.query.force === "true";
}

/**
 * On redirectedToLogin: clear the module-level session so the next
 * ensureSession() call triggers a fresh login, then retry once.
 */
async function withAutoRelogin<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === "session_expired") {
      clearSession();
      return fn();
    }
    throw err;
  }
}

// ─── Account ─────────────────────────────────────────────────────────────────

usmsRouter.post("/account", async (req: Request, res: Response) => {
  if (!isForced(req)) {
    const cached = getAccountCache();
    if (cached) return res.json({ meters: cached, fromCache: true, source: "cache" });

    // Try reading from normalized meter snapshots
    const snapshots = getLatestMeterSnapshots();
    if (snapshots.length > 0) {
      const meters = snapshots.map((s) => ({
        meterNo: s.meter_no,
        meterType: s.meter_type as "electricity" | "water",
        status: s.status,
        fullName: s.full_name,
        address: s.address,
        kampong: "",
        mukim: "",
        district: "",
        postcode: "",
        remainingUnit: s.remaining_unit,
        remainingUnitLabel: s.unit_label,
        remainingBalance: s.balance,
        lastUpdated: s.last_updated,
        reportParam: "",
        reportParamTransaction: "",
      }));
      return res.json({ meters, fromCache: true, source: "normalized" });
    }
  }

  try {
    const session = await ensureSession();

    const fetchMeters = async () => {
      const homeResult = await usmsGet("/SmartMeter/Home", session.cookies);
      if (homeResult.redirectedToLogin) throw new Error("session_expired");
      return parseHomePage(homeResult.html);
    };

    const meters = await withAutoRelogin(fetchMeters);
    setAccountCache(meters);
    return res.json({ meters, fromCache: false, source: "scraper" });
  } catch (err) {
    console.error("[usms/account]", (err as Error).message);
    return res.status(500).json({ error: "Failed to fetch account data" });
  }
});

// ─── Meter details ────────────────────────────────────────────────────────────

usmsRouter.post("/meter-details", async (req: Request, res: Response) => {
  const { meterNo } = req.body as { meterNo?: unknown };
  if (typeof meterNo !== "string" || !meterNo) {
    return res.status(400).json({ error: "meterNo is required" });
  }

  if (!isForced(req)) {
    const cached = getMeterDetailsCache(meterNo);
    if (cached) return res.json({ meter: cached, fromCache: true });
  }

  try {
    const session = await ensureSession();

    const fetchMeter = async () => {
      const homeResult = await usmsGet("/SmartMeter/Home", session.cookies);
      if (homeResult.redirectedToLogin) throw new Error("session_expired");
      const meters = parseHomePage(homeResult.html);
      const meter = meters.find((m: Meter) => m.meterNo === meterNo);
      if (!meter) return null;
      setAccountCache(meters);
      return meter;
    };

    const meter = await withAutoRelogin(fetchMeter);
    if (!meter) return res.status(404).json({ error: "Meter not found" });

    setMeterDetailsCache(meterNo, meter);
    return res.json({ meter, fromCache: false });
  } catch (err) {
    console.error("[usms/meter-details]", (err as Error).message);
    return res.status(500).json({ error: "Failed to fetch meter details" });
  }
});

// ─── Consumption history ──────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

usmsRouter.post("/consumption-history", async (req: Request, res: Response) => {
  const { meterNo, startDate, endDate } = req.body as {
    meterNo?: unknown;
    startDate?: unknown;
    endDate?: unknown;
  };

  if (typeof meterNo !== "string" || !meterNo) {
    return res.status(400).json({ error: "meterNo is required" });
  }
  if (typeof startDate !== "string" || !DATE_RE.test(startDate)) {
    return res.status(400).json({ error: "startDate must be YYYY-MM-DD" });
  }
  if (typeof endDate !== "string" || !DATE_RE.test(endDate)) {
    return res.status(400).json({ error: "endDate must be YYYY-MM-DD" });
  }
  if (endDate < startDate) {
    return res.status(400).json({ error: "endDate must be >= startDate" });
  }

  // Enforce max 31-day range (daily data is "Max 1 month" per portal limit)
  const msPerDay = 24 * 60 * 60 * 1000;
  const dayDiff = Math.round(
    (new Date(endDate).getTime() - new Date(startDate).getTime()) / msPerDay
  );
  if (dayDiff > 31) {
    return res.status(400).json({ error: "Maximum range is 31 days for daily data" });
  }

  if (!isForced(req)) {
    // Try cache first
    const cached = getConsumptionCache(meterNo, startDate, endDate);
    if (cached) return res.json({ ...(cached as object), fromCache: true, source: "cache" });

    // Try normalized table
    const normalized = getDailyConsumption(meterNo, startDate, endDate);
    if (normalized.length > 0) {
      const records = normalized.map((r) => ({
        period: r.date,
        consumption: r.consumption,
      }));
      return res.json({ records, fromCache: true, source: "normalized" });
    }
  }

  try {
    const session = await ensureSession();

    // Validate meterNo belongs to this account + get reportParam
    let reportParam: string | undefined;
    const lookupMeter = async () => {
      const homeResult = await usmsGet("/SmartMeter/Home", session.cookies);
      if (homeResult.redirectedToLogin) throw new Error("session_expired");
      const meters = parseHomePage(homeResult.html);
      const meter = meters.find((m: Meter) => m.meterNo === meterNo);
      if (!meter) return null;
      setAccountCache(meters);
      return meter.reportParam;
    };

    reportParam = await withAutoRelogin(lookupMeter) ?? undefined;
    if (reportParam === undefined) {
      return res.status(404).json({ error: "Meter not found" });
    }

    // Use a fixed token key for the browser context (single user)
    const sessionToken = "default";
    const result = await fetchConsumptionHistory(
      reportParam,
      startDate,
      endDate,
      session.cookies,
      sessionToken
    );

    const payload = { records: result.records, warning: result.warning };
    setConsumptionCache(meterNo, startDate, endDate, payload);
    return res.json({ ...payload, fromCache: false, source: "scraper" });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === "session_expired") {
      clearSession();
      return res.status(503).json({ error: "Session expired — please retry" });
    }
    console.error("[usms/consumption-history]", msg);
    return res.status(500).json({ error: "Failed to fetch consumption history" });
  }
});

// ─── Topup history ────────────────────────────────────────────────────────────

usmsRouter.post("/topup-history", async (req: Request, res: Response) => {
  const { meterNo, startDate, endDate } = req.body as {
    meterNo?: unknown;
    startDate?: unknown;
    endDate?: unknown;
  };

  if (typeof meterNo !== "string" || !meterNo) {
    return res.status(400).json({ error: "meterNo is required" });
  }
  if (typeof startDate !== "string" || !DATE_RE.test(startDate)) {
    return res.status(400).json({ error: "startDate must be YYYY-MM-DD" });
  }
  if (typeof endDate !== "string" || !DATE_RE.test(endDate)) {
    return res.status(400).json({ error: "endDate must be YYYY-MM-DD" });
  }
  if (endDate < startDate) {
    return res.status(400).json({ error: "endDate must be >= startDate" });
  }

  if (!isForced(req)) {
    // Try cache first
    const cached = getTopupCache(meterNo, startDate, endDate);
    if (cached) return res.json({ ...(cached as object), fromCache: true, source: "cache" });

    // Try normalized table
    const normalized = getTopupTransactions(meterNo, startDate, endDate);
    if (normalized.length > 0) {
      const records = normalized.map((r) => ({
        topupDate: r.topup_date,
        transactionNo: r.transaction_no,
        meterNo: r.meter_no,
        topupAmount: r.topup_amount,
        initialLoanDebtCleared: r.debt_cleared,
        actualRechargeAmount: r.recharge_amount,
        unitsCredited: r.units_credited,
        paymentMode: r.payment_mode,
        siteName: r.site_name,
        source: r.source,
      }));
      return res.json({ records, fromCache: true, source: "normalized" });
    }
  }

  try {
    const session = await ensureSession();

    let reportParam: string | undefined;
    const lookupMeter = async () => {
      const homeResult = await usmsGet("/SmartMeter/Home", session.cookies);
      if (homeResult.redirectedToLogin) throw new Error("session_expired");
      const meters = parseHomePage(homeResult.html);
      const meter = meters.find((m: Meter) => m.meterNo === meterNo);
      if (!meter) return null;
      setAccountCache(meters);
      // Use the UsageHistory reportParam — navigating to UsageHistory?p=X sets the
      // meter context in the server session, which TransactionHistory then reads.
      return meter.reportParam;
    };

    reportParam = await withAutoRelogin(lookupMeter) ?? undefined;
    if (reportParam === undefined) {
      return res.status(404).json({ error: "Meter not found" });
    }

    const sessionToken = "default";
    const result = await fetchTopUpHistory(
      reportParam,
      startDate,
      endDate,
      session.cookies,
      sessionToken
    );

    const payload = { records: result.records, warning: result.warning };
    setTopupCache(meterNo, startDate, endDate, payload);
    return res.json({ ...payload, fromCache: false, source: "scraper" });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === "session_expired") {
      clearSession();
      return res.status(503).json({ error: "Session expired — please retry" });
    }
    console.error("[usms/topup-history]", msg);
    return res.status(500).json({ error: "Failed to fetch topup history" });
  }
});
