/**
 * Report page scrapers — hybrid HTTP + Playwright approach.
 *
 * The site uses DevExpress (DX) controls for date pickers. Plain HTTP scraping
 * cannot set date ranges because the server stores DX state in an encrypted
 * ASPxHiddenField1 blob — submitting a non-empty blob causes HTTP 500.
 *
 * Hybrid strategy (from investigation):
 *  - ConsumptionHistory: data is a server-rendered PNG chart only (no table,
 *    no Excel export on UsageHistory). Playwright hovers over each chart bar
 *    to read the DX tooltip, correlating position → month.
 *  - TopUpHistory: TransactionHistory has a DX DateEdit + Excel export.
 *    Playwright sets date range via the DX JS API, clicks Search, intercepts
 *    the download, and parses with xlsx.
 *
 * The Excel parsers (parseConsumptionXlsx, parseTopUpXlsx) are kept
 * as exported utilities used by unit tests.
 */

import ExcelJS from "exceljs";
import type { CookieJar } from "./client.js";
import { browserScraper } from "./browser.js";

export interface ConsumptionRecord {
  period: string;       // "YYYY-MM-DD" (daily)
  consumption: number;  // kWh or m³
  estimatedCost?: number;
}

export interface TopUpRecord {
  topupDate: string;            // ISO date "YYYY-MM-DD"
  transactionNo: string;
  meterNo: string;
  topupAmount: number;
  initialLoanDebtCleared: number;
  actualRechargeAmount: number;
  unitsCredited: number;
  paymentMode: string;
  siteName: string;
  source: string;
}

// ─── Excel parse helpers ──────────────────────────────────────────────────────

/** "October 2025" → "2025-10" (null if unrecognised) */
function parseMonthYear(s: string): string | null {
  const monthIndex: Record<string, string> = {
    january: "01", february: "02", march: "03", april: "04",
    may: "05", june: "06", july: "07", august: "08",
    september: "09", october: "10", november: "11", december: "12",
  };
  const m = s.trim().match(/^(\w+)\s+(\d{4})$/);
  if (m) {
    const mon = monthIndex[m[1].toLowerCase()];
    return mon ? `${m[2]}-${mon}` : null;
  }
  return null;
}

/** "06/04/2026" or "6/4/2026" → "2026-04-06" */
function parseDdMmYyyy(s: string): string {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return s;
}

function parseNumber(s: unknown): number {
  if (typeof s === "number") return isNaN(s) ? 0 : s;
  if (typeof s === "string") {
    const n = parseFloat(s.replace(/[^0-9.\-]/g, ""));
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function parseString(s: unknown): string {
  if (s === undefined || s === null) return "";
  return String(s).trim();
}

// ─── ExcelJS helper ───────────────────────────────────────────────────────────

/** Read an Excel buffer and return rows as arrays (like XLSX.utils.sheet_to_json with header:1) */
async function readExcelRows(buffer: Buffer): Promise<unknown[][]> {
  if (!buffer || buffer.length === 0) return [];
  try {
    const wb = new ExcelJS.Workbook();
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as unknown as ArrayBuffer;
    await wb.xlsx.load(ab);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const rows: unknown[][] = [];
    ws.eachRow((row) => {
      rows.push(row.values ? (row.values as unknown[]).slice(1) : []);
    });
    return rows;
  } catch {
    return [];
  }
}

// ─── Excel parsers ────────────────────────────────────────────────────────────

/**
 * Parse a consumption history Excel buffer.
 *
 * Expected columns (Monthly report):
 *   Month | Consumption (kWh) | Consumption (m³)
 * The exact header text varies — we detect the month column and the first
 * numeric column after it.
 */
export async function parseConsumptionXlsx(buffer: Buffer): Promise<ConsumptionRecord[]> {
  const rows = await readExcelRows(buffer);
  if (rows.length < 2) return [];

  // Find header row (first row containing "month" or "period" text)
  let headerRowIdx = 0;
  let monthColIdx = -1;
  let consumColIdx = -1;

  for (let ri = 0; ri < Math.min(rows.length, 5); ri++) {
    const row = rows[ri] as unknown[];
    const texts = row.map((c) => parseString(c).toLowerCase());
    const mi = texts.findIndex(
      (t) => t.includes("month") || t.includes("period")
    );
    if (mi !== -1) {
      headerRowIdx = ri;
      monthColIdx = mi;
      // The consumption column is the next non-empty numeric-ish column
      consumColIdx = texts.findIndex(
        (t, idx) =>
          idx > mi &&
          (t.includes("consumption") ||
            t.includes("usage") ||
            t.includes("kwh") ||
            t.includes("m3") ||
            t.includes("unit"))
      );
      if (consumColIdx === -1) {
        // Fall back: first column after monthColIdx
        consumColIdx = mi + 1;
      }
      break;
    }
  }

  if (monthColIdx === -1) return [];

  const records: ConsumptionRecord[] = [];
  for (let ri = headerRowIdx + 1; ri < rows.length; ri++) {
    const row = rows[ri] as unknown[];
    const periodRaw = parseString(row[monthColIdx]);
    if (!periodRaw) continue;

    const period = parseMonthYear(periodRaw);
    if (!period) continue;

    const consumption = parseNumber(row[consumColIdx] ?? "");
    if (consumption >= 0) {
      records.push({ period, consumption });
    }
  }

  return records;
}

/**
 * Parse a topup transaction history Excel buffer.
 *
 * Expected columns (TopUp History report):
 *   Topup Date | Transaction No | Meter No | Topup Amount ($) |
 *   Initial Loan/Debt Cleared ($) | Actual Recharge Amount ($) |
 *   Units Credited | Payment Mode | Site Name | Source
 */
export async function parseTopUpXlsx(buffer: Buffer): Promise<TopUpRecord[]> {
  const rows = await readExcelRows(buffer);
  if (rows.length < 2) return [];

  // Locate header row
  let headerRowIdx = 0;
  let headers: string[] = [];

  for (let ri = 0; ri < Math.min(rows.length, 5); ri++) {
    const row = rows[ri] as unknown[];
    const texts = row.map((c) => parseString(c).toLowerCase());
    if (texts.some((t) => t.includes("topup date") || (t.includes("topup") && t.includes("date")))) {
      headerRowIdx = ri;
      headers = texts;
      break;
    }
  }

  if (headers.length === 0) return [];

  const col = (keyword: string): number =>
    headers.findIndex((h) => h.includes(keyword));

  const dateIdx       = col("topup date");
  const txnIdx        = col("transaction");
  const meterIdx      = col("meter no");
  const topupAmtIdx   = col("topup amount");
  const loanIdx       = col("loan");
  const rechargeIdx   = col("actual recharge");
  const unitsIdx      = col("units credited");
  const modeIdx       = col("payment mode");
  const siteIdx       = col("site name");
  const sourceIdx     = col("source");

  const records: TopUpRecord[] = [];

  for (let ri = headerRowIdx + 1; ri < rows.length; ri++) {
    const row = rows[ri] as unknown[];
    const dateRaw = parseString(row[dateIdx >= 0 ? dateIdx : 0]);
    if (!dateRaw || dateRaw.toLowerCase().includes("no data")) continue;

    records.push({
      topupDate:              parseDdMmYyyy(dateRaw),
      transactionNo:          parseString(row[txnIdx >= 0 ? txnIdx : 1]),
      meterNo:                parseString(row[meterIdx >= 0 ? meterIdx : 2]),
      topupAmount:            parseNumber(row[topupAmtIdx >= 0 ? topupAmtIdx : 3]),
      initialLoanDebtCleared: parseNumber(row[loanIdx >= 0 ? loanIdx : 4]),
      actualRechargeAmount:   parseNumber(row[rechargeIdx >= 0 ? rechargeIdx : 5]),
      unitsCredited:          parseNumber(row[unitsIdx >= 0 ? unitsIdx : 6]),
      paymentMode:            parseString(row[modeIdx >= 0 ? modeIdx : 7]),
      siteName:               parseString(row[siteIdx >= 0 ? siteIdx : 8]),
      source:                 parseString(row[sourceIdx >= 0 ? sourceIdx : 9]),
    });
  }

  return records;
}

// ─── Playwright-based fetchers ────────────────────────────────────────────────

/**
 * Fetch daily consumption history for a meter using Playwright (Data View table strategy).
 *
 * The UsageHistory page supports a "Daily (Max 1 month)" report type.
 * Playwright selects the daily type, sets the date range, clicks Search, then
 * clicks the "Data View" tab to read an HTML table of date → kWh rows.
 *
 * Max range: 31 days (portal enforces "Max 1 month").
 *
 * The sessionToken is required for the browser context. Callers must pass the
 * same sessionToken used for the HTTP session so we can reuse the browser
 * context without re-logging in.
 *
 * @param sessionToken — opaque session identifier (from SessionManager)
 */
export async function fetchConsumptionHistory(
  reportParam: string,
  startDate: string,  // YYYY-MM-DD
  endDate: string,    // YYYY-MM-DD
  jar: CookieJar,
  sessionToken?: string
): Promise<{ records: ConsumptionRecord[]; warning?: string }> {
  const token = sessionToken ?? `anon-${reportParam}`;
  return browserScraper.fetchConsumptionHistory(
    token,
    jar,
    reportParam,
    startDate,
    endDate
  );
}

/**
 * Fetch topup transaction history for a meter using Playwright + Excel export.
 *
 * Playwright navigates to TransactionHistory, sets the date range via the DX
 * DateEdit JS API (SetDate), clicks Search, then intercepts the Excel download
 * triggered by "Export Excel". The Excel is parsed and returned as TopUpRecord[].
 *
 * This resolves the limitation of the plain HTTP approach where the server
 * always returned today's date range (the DX state was empty → server default).
 *
 * @param sessionToken — opaque session identifier (from SessionManager)
 */
export async function fetchTopUpHistory(
  reportParam: string,
  startDate: string, // YYYY-MM-DD
  endDate: string,   // YYYY-MM-DD
  jar: CookieJar,
  sessionToken?: string
): Promise<{ records: TopUpRecord[]; warning?: string }> {
  const token = sessionToken ?? `anon-${reportParam}`;
  return browserScraper.fetchTopUpHistory(
    token,
    jar,
    reportParam,
    startDate,
    endDate
  );
}
