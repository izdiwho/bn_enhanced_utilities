/**
 * Playwright-based browser scraper for SmartMeter report pages.
 *
 * The site uses DevExpress controls whose state is managed entirely client-side.
 * Plain HTTP postbacks cannot set date ranges (the server 500s on non-empty
 * ASPxHiddenField1). A headless browser is required to interact with the DX
 * JavaScript API and then extract data.
 *
 * Architecture:
 *  - Single shared Chromium instance (lazy-launched on first use).
 *  - One BrowserContext per session token (isolated cookie jar).
 *  - Contexts are reused across calls for the same session to avoid re-login.
 *  - Idle contexts are closed after 10 minutes to free memory.
 *  - All navigation uses a 30-second timeout (the portal may be slow).
 *
 * Consumption history extraction strategy:
 *  The UsageHistory page renders data as a server-side PNG chart (DXB.axd).
 *  There is no HTML table or Excel export. The only way to extract values is
 *  to hover the mouse over each bar in the chart and read the DX tooltip element.
 *  We know the months from the requested range, and bars appear left-to-right
 *  in chronological order, so we can correlate hover position → month.
 *
 * TopUp history extraction strategy:
 *  TransactionHistory shows a DX GridView and an "Export Excel" button.
 *  We set date range via the DX DateEdit JS API (SetDate), click Search,
 *  intercept the Excel download, and parse it with xlsx.
 *
 * SECURITY: session cookies are passed in from the HTTP login (never re-entered
 * here). Passwords are never seen by this module.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import ExcelJS from "exceljs";
import { USMS_BASE_URL, DEFAULT_UA, type CookieJar } from "./client.js";
import type { ConsumptionRecord, TopUpRecord } from "./reports.js";

const NAVIGATION_TIMEOUT = 30_000;
const CONTEXT_IDLE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SWEEP_INTERVAL_MS  = 2  * 60 * 1000;  // sweep every 2 min

interface ContextEntry {
  context: BrowserContext;
  page: Page;
  lastUsed: number;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

/** "2025-10" → { year: 2025, monthIndex: 9 } (0-based month for JS Date) */
function parseYearMonth(ym: string): { year: number; monthIndex: number } {
  const [y, m] = ym.split("-").map(Number);
  return { year: y, monthIndex: m - 1 };
}

/** Generate list of YYYY-MM strings between startMonth and endMonth inclusive */
function monthRange(startMonth: string, endMonth: string): string[] {
  const months: string[] = [];
  const { year: sy, monthIndex: sm } = parseYearMonth(startMonth);
  const { year: ey, monthIndex: em } = parseYearMonth(endMonth);
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}-${String(m + 1).padStart(2, "0")}`);
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return months;
}

/** "2025-10-01" → JavaScript Date */
function isoToDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Extract numeric value from a tooltip string like "2,048.930 kWh" or "24.122 m³" */
function parseScrapeValue(text: string): number {
  const match = text.replace(/,/g, "").match(/[\d.]+/);
  return match ? parseFloat(match[0]) : 0;
}

/** Parse Excel serial number date → "YYYY-MM-DD" */
function excelSerialToIso(serial: number): string {
  // Excel epoch: January 0, 1900 (day 1 = Jan 1, 1900). Excel bug: treats 1900 as leap year.
  const excelEpoch = new Date(1899, 11, 30); // Dec 30, 1899
  const ms = excelEpoch.getTime() + serial * 86400000;
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ─── BrowserScraper class ──────────────────────────────────────────────────────

class BrowserScraper {
  private browser: Browser | null = null;
  private contexts = new Map<string, ContextEntry>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  // ─── Browser lifecycle ──────────────────────────────────────────────────────

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    this.browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage", // use /tmp instead of /dev/shm (Docker)
        "--disable-gpu",
        "--disable-extensions",
      ],
    });
    this.startSweep();
    return this.browser;
  }

  /** Get or create a BrowserContext for a given session token. */
  private async getContext(
    sessionToken: string,
    cookies: CookieJar
  ): Promise<{ context: BrowserContext; page: Page }> {
    const existing = this.contexts.get(sessionToken);
    if (existing) {
      existing.lastUsed = Date.now();
      return { context: existing.context, page: existing.page };
    }

    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      userAgent: DEFAULT_UA,
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
    });

    // Inject session cookies into the browser context
    const cookieObjects = Array.from(cookies.entries()).map(([name, value]) => ({
      name,
      value,
      domain:   "www.usms.com.bn",
      path:     "/",
      httpOnly: false,
      secure:   true,
      sameSite: "Lax" as const,
    }));
    if (cookieObjects.length) {
      await context.addCookies(cookieObjects);
    }

    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
    page.setDefaultTimeout(NAVIGATION_TIMEOUT);

    this.contexts.set(sessionToken, { context, page, lastUsed: Date.now() });
    return { context, page };
  }

  // ─── Session management ─────────────────────────────────────────────────────

  /** Remove a session's context — call on logout or session expiry. */
  async closeContext(sessionToken: string): Promise<void> {
    const entry = this.contexts.get(sessionToken);
    if (!entry) return;
    this.contexts.delete(sessionToken);
    try { await entry.context.close(); } catch {}
  }

  /** Sync cookies from an HTTP CookieJar into an existing browser context. */
  async syncCookies(sessionToken: string, cookies: CookieJar): Promise<void> {
    const entry = this.contexts.get(sessionToken);
    if (!entry) return;
    const cookieObjects = Array.from(cookies.entries()).map(([name, value]) => ({
      name,
      value,
      domain:   "www.usms.com.bn",
      path:     "/",
      secure:   true,
      sameSite: "Lax" as const,
    }));
    if (cookieObjects.length) {
      await entry.context.addCookies(cookieObjects);
    }
  }

  // ─── Idle-context sweep ────────────────────────────────────────────────────

  private startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    if (this.sweepTimer?.unref) this.sweepTimer.unref();
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const [token, entry] of this.contexts) {
      if (now - entry.lastUsed > CONTEXT_IDLE_TTL_MS) {
        this.contexts.delete(token);
        try { await entry.context.close(); } catch {}
      }
    }
  }

  /** Close the browser entirely (call on process exit). */
  async cleanup(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const entry of this.contexts.values()) {
      try { await entry.context.close(); } catch {}
    }
    this.contexts.clear();
    if (this.browser) {
      try { await this.browser.close(); } catch {}
      this.browser = null;
    }
  }

  // ─── Consumption history (UsageHistory page, daily Data View table strategy) ──

  /**
   * Fetch daily consumption history for a meter via Playwright.
   *
   * Primary strategy (daily Data View table):
   *  1. Navigate to /SmartMeter/Report/UsageHistory?p=<reportParam>
   *  2. Select "Daily (Max 1 month)" via cboType.SetSelectedIndex(1)
   *  3. Wait for UpdatePanel autoPostBack
   *  4. Set cboDateFrom / cboDateTo using the DX JS API (SetDate) with day-level dates
   *  5. Click Search
   *  6. Wait for chart image to reload
   *  7. Click "Data View" tab to reveal the HTML table
   *  8. Parse rows: DD/MM/YYYY | value pairs
   *  9. Convert dates to YYYY-MM-DD for the period field
   *
   * Fallback (monthly chart hover):
   *  If the Data View table returns no rows, falls back to the original
   *  monthly hover strategy treating startDate/endDate as month boundaries.
   */
  async fetchConsumptionHistory(
    sessionToken: string,
    cookies: CookieJar,
    reportParam: string,
    startDate: string, // "YYYY-MM-DD"
    endDate: string    // "YYYY-MM-DD"
  ): Promise<{ records: ConsumptionRecord[]; warning?: string }> {
    const { page } = await this.getContext(sessionToken, cookies);

    const url = `${USMS_BASE_URL}/SmartMeter/Report/UsageHistory?p=${encodeURIComponent(reportParam)}`;

    try {
      await page.goto(url, { waitUntil: "networkidle" });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.toLowerCase().includes("login") || msg.toLowerCase().includes("session")) {
        throw new Error("session_expired");
      }
      throw err;
    }

    // Check for session expiry (page redirected to login)
    if (page.url().toLowerCase().includes("reslogin") || page.url().toLowerCase().includes("login")) {
      throw new Error("session_expired");
    }

    // ── Step 1: Select "Daily (Max 1 month)" via cboType ──────────────────────
    await page.evaluate(
      /* istanbul ignore next */
      () => {
        const cc = (globalThis as any).ASPx?.GetControlCollection(); // eslint-disable-line @typescript-eslint/no-explicit-any
        cc?.GetByName("cboType")?.SetSelectedIndex(1);
      }
    );

    // Wait for UpdatePanel autoPostBack
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await new Promise<void>(r => setTimeout(r, 1500));

    // ── Step 2: Set date range using DX DateEdit JS API ────────────────────────
    const startDateObj = isoToDate(startDate);
    const endDateObj   = isoToDate(endDate);

    await page.evaluate(
      /* istanbul ignore next */
      (args: number[]) => {
        const [sy, sm, sd, ey, em, ed] = args;
        const cc = (globalThis as any).ASPx?.GetControlCollection(); // eslint-disable-line @typescript-eslint/no-explicit-any
        const dateFrom = cc?.GetByName("cboDateFrom");
        const dateTo   = cc?.GetByName("cboDateTo");
        if (dateFrom) dateFrom.SetDate(new Date(sy, sm, sd));
        if (dateTo)   dateTo.SetDate(new Date(ey, em, ed));
      },
      [
        startDateObj.getFullYear(), startDateObj.getMonth(), startDateObj.getDate(),
        endDateObj.getFullYear(),   endDateObj.getMonth(),   endDateObj.getDate(),
      ]
    );

    // ── Step 3: Capture old chart src, then click Search ──────────────────────
    const oldImgSrc = await page.$eval(
      "#ASPxPageControl1_WebChartControl2_IMG",
      /* istanbul ignore next */
      (el: any) => (el as any).src as string // eslint-disable-line @typescript-eslint/no-explicit-any
    ).catch(() => "");

    await page.evaluate(
      /* istanbul ignore next */
      () => {
        const btn = (globalThis as any).document.getElementById("btnRefresh_I"); // eslint-disable-line @typescript-eslint/no-explicit-any
        if (btn) btn.click();
      }
    );

    // Wait for chart image to change (new DXCache token in src)
    try {
      await page.waitForFunction(
        /* istanbul ignore next */
        (prevSrc: string) => {
          const img = (globalThis as any).document // eslint-disable-line @typescript-eslint/no-explicit-any
            .getElementById("ASPxPageControl1_WebChartControl2_IMG") as any; // eslint-disable-line @typescript-eslint/no-explicit-any
          return img && img.complete && img.naturalWidth > 0 && img.src !== prevSrc;
        },
        oldImgSrc,
        { timeout: 30_000, polling: 500 }
      );
    } catch {
      // Chart may not have changed if there's no data; continue to Data View
    }

    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await new Promise<void>(r => setTimeout(r, 1500));

    // ── Step 4: Click "Data View" tab ─────────────────────────────────────────
    await page.evaluate(
      /* istanbul ignore next */
      () => {
        const w = globalThis as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        const tabs = w.document.querySelectorAll("li, td, span, div");
        const dvTab = Array.from(tabs as any[]).find( // eslint-disable-line @typescript-eslint/no-explicit-any
          (el: any) => el.innerText?.trim() === "Data View" // eslint-disable-line @typescript-eslint/no-explicit-any
        );
        if (dvTab) (dvTab as any).click(); // eslint-disable-line @typescript-eslint/no-explicit-any
      }
    );
    await new Promise<void>(r => setTimeout(r, 1500));

    // ── Step 5: Scrape the HTML table ─────────────────────────────────────────
    const rows = await page.$$eval(
      "table tr",
      /* istanbul ignore next */
      (trs: any[]) => // eslint-disable-line @typescript-eslint/no-explicit-any
        trs.map((r: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          const cells = Array.from(r.querySelectorAll("td")) as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
          return cells.length >= 2
            ? { date: cells[0].innerText.trim() as string, value: cells[1].innerText.trim() as string }
            : null;
        }).filter(Boolean) as { date: string; value: string }[]
    ).catch(() => [] as { date: string; value: string }[]);

    // Filter to rows that look like date-value pairs (DD/MM/YYYY format)
    const dataRows = rows.filter(r => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(r.date));

    if (dataRows.length > 0) {
      // Convert DD/MM/YYYY → YYYY-MM-DD and parse numeric consumption
      const records: ConsumptionRecord[] = dataRows.map(r => {
        const [dd, mm, yyyy] = r.date.split("/");
        const period = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
        const consumption = parseScrapeValue(r.value);
        return { period, consumption };
      });

      // Filter to dates within requested range
      const filtered = records.filter(r => r.period >= startDate && r.period <= endDate);
      return { records: filtered };
    }

    // ── Fallback: no table data — return empty with warning ───────────────────
    return { records: [], warning: "no_daily_data" };
  }

  // ─── Monthly hover fallback (kept for reference, not used by default) ────────

  /**
   * Legacy monthly chart hover strategy.
   * Kept as a fallback — not used by default since daily Data View is more reliable.
   */
  async fetchConsumptionHistoryMonthly(
    sessionToken: string,
    cookies: CookieJar,
    reportParam: string,
    startMonth: string, // "YYYY-MM"
    endMonth: string    // "YYYY-MM"
  ): Promise<{ records: ConsumptionRecord[]; warning?: string }> {
    const { page } = await this.getContext(sessionToken, cookies);

    const url = `${USMS_BASE_URL}/SmartMeter/Report/UsageHistory?p=${encodeURIComponent(reportParam)}`;

    try {
      await page.goto(url, { waitUntil: "networkidle" });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.toLowerCase().includes("login") || msg.toLowerCase().includes("session")) {
        throw new Error("session_expired");
      }
      throw err;
    }

    if (page.url().toLowerCase().includes("reslogin") || page.url().toLowerCase().includes("login")) {
      throw new Error("session_expired");
    }

    const { year: sy, monthIndex: sm } = parseYearMonth(startMonth);
    const { year: ey, monthIndex: em } = parseYearMonth(endMonth);

    await page.evaluate(
      /* istanbul ignore next */
      (args: number[]) => {
        const [syArg, smArg, eyArg, emArg] = args;
        const w = globalThis as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        const cc = w.ASPx?.GetControlCollection();
        const dateFrom = cc?.GetByName("cboDateFrom");
        const dateTo   = cc?.GetByName("cboDateTo");
        if (dateFrom) dateFrom.SetDate(new Date(syArg, smArg, 1));
        if (dateTo)   dateTo.SetDate(new Date(eyArg, emArg, 1));
      },
      [sy, sm, ey, em]
    );

    await page.evaluate(
      /* istanbul ignore next */
      () => {
        const btn = (globalThis as any).document.getElementById("btnRefresh_I"); // eslint-disable-line @typescript-eslint/no-explicit-any
        if (btn) btn.click();
      }
    );

    try {
      await page.waitForFunction(
        /* istanbul ignore next */
        () => {
          const img = (globalThis as any).document.getElementById("ASPxPageControl1_WebChartControl2_IMG"); // eslint-disable-line @typescript-eslint/no-explicit-any
          return img && img.complete && img.naturalWidth > 0;
        },
        { timeout: 25_000, polling: 500 }
      );
      await new Promise<void>(r => setTimeout(r, 2000));
    } catch {
      // continue
    }

    const months = monthRange(startMonth, endMonth);

    const chartBox = await page.$eval(
      "#ASPxPageControl1_WebChartControl2",
      /* istanbul ignore next */
      (el: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }
    ).catch(() => null);

    if (!chartBox || chartBox.w === 0) {
      return { records: [], warning: "chart_not_rendered" };
    }

    const chartLeft  = chartBox.x + 90;
    const chartRight = chartBox.x + chartBox.w - 30;
    const chartMidY  = chartBox.y + chartBox.h * 0.65;
    const count      = months.length;

    const tooltipSelector = "#ASPxPageControl1\\$WebChartControl2_CHL-0";
    const records: ConsumptionRecord[] = [];
    const seenValues = new Set<string>();

    for (let i = 0; i < count; i++) {
      const x = chartLeft + (chartRight - chartLeft) * (i + 0.5) / count;
      await page.mouse.move(x, chartMidY);
      await new Promise<void>(r => setTimeout(r, 600));

      const tooltipText = await page.$eval(
        tooltipSelector,
        /* istanbul ignore next */
        (el: any) => (el.innerText?.trim() ?? "") as string // eslint-disable-line @typescript-eslint/no-explicit-any
      ).catch(() => "");

      if (tooltipText && !seenValues.has(tooltipText)) {
        seenValues.add(tooltipText);
        records.push({ period: months[i], consumption: parseScrapeValue(tooltipText) });
      } else if (tooltipText && seenValues.has(tooltipText)) {
        const x2 = chartLeft + (chartRight - chartLeft) * (i + 0.3) / count;
        await page.mouse.move(x2, chartMidY);
        await new Promise<void>(r => setTimeout(r, 400));
        const t2 = await page.$eval(
          tooltipSelector,
          /* istanbul ignore next */
          (el: any) => (el.innerText?.trim() ?? "") as string // eslint-disable-line @typescript-eslint/no-explicit-any
        ).catch(() => "");
        records.push({ period: months[i], consumption: parseScrapeValue(t2 || tooltipText) });
      } else {
        records.push({ period: months[i], consumption: 0 });
      }
    }

    const valid = records.filter(r => r.consumption >= 0);
    const warning = valid.length !== count ? "partial_data" : undefined;
    return { records: valid, warning };
  }

  // ─── TopUp history (TransactionHistory page, Excel export strategy) ─────────

  /**
   * Fetch topup transaction history for a meter via Playwright.
   *
   * Strategy:
   *  1. Navigate to /SmartMeter/Report/TransactionHistory?p=<reportParam>
   *  2. Set cboDateFrom / cboDateTo using the DX DateEdit JS API (SetDate)
   *  3. Click Search (via JS eval)
   *  4. Wait for table to load
   *  5. Intercept the "Export Excel" download
   *  6. Parse with xlsx
   */
  async fetchTopUpHistory(
    sessionToken: string,
    cookies: CookieJar,
    reportParam: string,
    startDate: string, // "YYYY-MM-DD"
    endDate: string    // "YYYY-MM-DD"
  ): Promise<{ records: TopUpRecord[]; warning?: string }> {
    const { context } = await this.getContext(sessionToken, cookies);

    // Create a dedicated page for topup — avoids navigation collisions
    // with the consumption scraper which shares the same context.
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
    page.setDefaultTimeout(NAVIGATION_TIMEOUT);

    try {
      return await this._fetchTopUpHistoryOnPage(page, reportParam, startDate, endDate);
    } finally {
      await page.close().catch(() => {});
    }
  }

  private async _fetchTopUpHistoryOnPage(
    page: Page,
    reportParam: string,
    startDate: string,
    endDate: string,
  ): Promise<{ records: TopUpRecord[]; warning?: string }> {
    // ── Step 1: Navigate to MainPage (establishes the shell with the iframe) ──
    // The SmartMeter report pages require being loaded inside the iframe on MainPage.
    // The meter context is set server-side by navigating to UsageHistory?p=<meter>.
    try {
      await page.goto(`${USMS_BASE_URL}/SmartMeter/MainPage`, { waitUntil: "networkidle" });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.toLowerCase().includes("login") || msg.toLowerCase().includes("session")) {
        throw new Error("session_expired");
      }
      throw err;
    }

    if (page.url().toLowerCase().includes("reslogin") || page.url().toLowerCase().includes("login")) {
      throw new Error("session_expired");
    }

    // ── Step 2: Get the iframe and navigate it to UsageHistory?p=<reportParam> ─
    // This sets the meter context in the server session (the `p` parameter encodes
    // the meter number). The same approach works in fetchConsumptionHistory.
    const iframeHandle = await page.$("iframe#MyFrame");
    const frame = iframeHandle ? await iframeHandle.contentFrame() : null;

    if (!frame) {
      throw new Error("iframe#MyFrame not found on MainPage — session may be expired");
    }

    // Navigate the iframe to UsageHistory with the meter param to set session context
    await frame.goto(
      `${USMS_BASE_URL}/SmartMeter/Report/UsageHistory?p=${reportParam}`,
      { waitUntil: "networkidle" }
    ).catch(() => {});
    await new Promise<void>(r => setTimeout(r, 1000));

    // ── Step 3: Click "Topup Transaction" in the MAIN PAGE sidebar ───────────
    // The sidebar link loads TransactionHistory into the iframe. Because the server
    // session now has the correct meter context (set in Step 2), the report will
    // show data for our meter.
    await page.evaluate(
      /* istanbul ignore next */
      () => {
        const w = globalThis as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        const links = Array.from(w.document.querySelectorAll("a")) as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
        for (const link of links) {
          if ((link.textContent || "").trim() === "Topup Transaction") {
            link.click();
            return;
          }
        }
      }
    );

    // ── Step 4: Wait for iframe to reload with TransactionHistory ─────────────
    await new Promise<void>(r => setTimeout(r, 2000));
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await new Promise<void>(r => setTimeout(r, 1500));

    // Re-acquire the iframe frame object — it is a new frame after navigation
    const newIframeHandle = await page.$("iframe#MyFrame");
    const txFrame = newIframeHandle ? await newIframeHandle.contentFrame() : null;

    if (!txFrame) {
      throw new Error("iframe#MyFrame disappeared after Topup Transaction navigation");
    }

    await txFrame.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});

    // ── Step 5: Set date range ─────────────────────────────────────────────
    // Note: DX DateEdit SetDate() inside an iframe doesn't propagate to the
    // server-side viewstate. Instead, we use Playwright's fill() to type the
    // dates directly into the input fields, which triggers the DX client-side
    // validation and updates the hidden state.
    const startDateObj = isoToDate(startDate);
    const endDateObj   = isoToDate(endDate);

    // Format as DD/MM/YYYY (what the date fields expect)
    const fmtDate = (d: Date) =>
      `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

    const fromStr = fmtDate(startDateObj);
    const toStr   = fmtDate(endDateObj);

    // Clear and type into the date inputs
    const fromInput = txFrame.locator("input#cboDateFrom_I, input[name='cboDateFrom']").first();
    const toInput   = txFrame.locator("input#cboDateTo_I, input[name='cboDateTo']").first();


    // Triple-click to select all text, then type the new date
    try {
      await fromInput.click({ clickCount: 3, timeout: 5000 });
      await fromInput.pressSequentially(fromStr, { delay: 30 });
      await fromInput.press("Tab");
      await new Promise<void>(r => setTimeout(r, 500));

      await toInput.click({ clickCount: 3, timeout: 5000 });
      await toInput.pressSequentially(toStr, { delay: 30 });
      await toInput.press("Tab");
      await new Promise<void>(r => setTimeout(r, 500));

    } catch {
      await txFrame.evaluate(
        (args: number[]) => {
          const [sy, sm, sd, ey, em, ed] = args;
          const w = globalThis as any;
          const cc = w.ASPx?.GetControlCollection();
          const dateFrom = cc?.GetByName("cboDateFrom");
          const dateTo   = cc?.GetByName("cboDateTo");
          if (dateFrom) dateFrom.SetDate(new Date(sy, sm, sd));
          if (dateTo)   dateTo.SetDate(new Date(ey, em, ed));
        },
        [
          startDateObj.getFullYear(), startDateObj.getMonth(), startDateObj.getDate(),
          endDateObj.getFullYear(),   endDateObj.getMonth(),   endDateObj.getDate(),
        ]
      );
    }

    await txFrame.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await new Promise<void>(r => setTimeout(r, 500));

    // ── Step 6: Click Search inside the iframe ────────────────────────────────
    await txFrame.evaluate(
      /* istanbul ignore next */
      () => {
        const w = globalThis as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        const btn = w.document.getElementById("btnRefresh_I")
          ?? w.document.getElementById("btnRefresh")
          ?? w.document.querySelector("[id*='btnRefresh']")
          ?? w.document.querySelector("input[value='Search']");
        if (btn) btn.click();
      }
    );

    // Wait for table to reload
    await txFrame.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await new Promise<void>(r => setTimeout(r, 2000));

    // ── Step 7: Check whether there is data in the table ─────────────────────
    // The DX GridView renders a row with class "dxgvEmptyDataRow" when there are
    // no records. We check for this specifically to avoid false positives from
    // pagination footer text ("No data to paginate") which is always present.
    const hasNoData = await txFrame.evaluate(
      /* istanbul ignore next */
      () => {
        const w = globalThis as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        const doc = w.document;
        const emptyRow = doc.querySelector(".dxgvEmptyDataRow");
        return !!emptyRow;
      }
    ).catch(() => false);

    if (hasNoData) {
      return { records: [], warning: "no_data_for_range" };
    }

    // ── Step 8: Click "Export Excel" — download is intercepted at PAGE level ──
    // Even though the button is inside the iframe, Playwright fires the "download"
    // event on the top-level page object.
    const dlPromise = page.waitForEvent("download", { timeout: 20_000 });

    await txFrame.evaluate(
      /* istanbul ignore next */
      () => {
        const w = globalThis as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        const btn = w.document.getElementById("btnExportXlsx_I")
          ?? w.document.getElementById("btnExportXlsx")
          ?? w.document.querySelector("[id*='Export']")
          ?? w.document.querySelector("[id*='export']")
          ?? w.document.querySelector("input[value*='Export']");
        if (btn) btn.click();
      }
    );

    let download;
    try {
      download = await dlPromise;
    } catch {
      return { records: [], warning: "export_timeout" };
    }

    const buffer = await download.createReadStream().then(
      (stream) =>
        new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => resolve(Buffer.concat(chunks)));
          stream.on("error", reject);
        })
    ).catch(() => null);

    if (!buffer || buffer.length === 0) {
      return { records: [], warning: "empty_export" };
    }

    const records = await parseTopUpXlsxFromBrowser(buffer);
    const warning = records.length === 0 ? "no_data_for_range" : undefined;
    return { records, warning };
  }
}

// ─── Excel parser (matches the one in reports.ts but handles serial dates) ────

function parseString(s: unknown): string {
  if (s === undefined || s === null) return "";
  return String(s).trim();
}

function parseNumber(s: unknown): number {
  if (typeof s === "number") return isNaN(s) ? 0 : s;
  if (typeof s === "string") {
    const n = parseFloat(s.replace(/[^0-9.\-]/g, ""));
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function parseDateField(raw: unknown): string {
  // ExcelJS returns Date objects for date cells
  if (raw instanceof Date) {
    return `${raw.getFullYear()}-${String(raw.getMonth() + 1).padStart(2, "0")}-${String(raw.getDate()).padStart(2, "0")}`;
  }
  if (typeof raw === "number") {
    // Excel serial date
    return excelSerialToIso(raw);
  }
  if (typeof raw === "string" && raw.trim()) {
    // ISO date string from exceljs (e.g. "2025-03-02T15:08:37.000Z")
    const iso = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    // DD/MM/YYYY
    const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    return raw;
  }
  return "";
}

async function parseTopUpXlsxFromBrowser(buffer: Buffer): Promise<TopUpRecord[]> {
  const wb = new ExcelJS.Workbook();
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as unknown as ArrayBuffer;
  await wb.xlsx.load(ab);
  const ws = wb.worksheets[0];
  if (!ws) return [];

  const rows: unknown[][] = [];
  ws.eachRow((row) => {
    rows.push(row.values ? (row.values as unknown[]).slice(1) : []);
  });
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
    const rawDate = row[dateIdx >= 0 ? dateIdx : 0];
    const dateStr = parseDateField(rawDate);
    if (!dateStr || dateStr.toLowerCase().includes("no data")) continue;

    records.push({
      topupDate:              dateStr,
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

// ─── Singleton ────────────────────────────────────────────────────────────────

export const browserScraper = new BrowserScraper();

// Close browser on process exit
process.on("SIGTERM", () => browserScraper.cleanup());
process.on("SIGINT",  () => browserScraper.cleanup());
process.on("exit",    () => { /* sync close not possible */ });
