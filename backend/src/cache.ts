/**
 * SQLite cache layer (WAL mode).
 *
 * Tables: consumption_cache, topup_cache, account_cache, meter_details_cache.
 *
 * TTL rules:
 *   - consumption/topup: cached forever if range ends before current month/day (immutable history).
 *   - account/meter-details: 5-minute TTL.
 *   - ?force=true bypasses cache at the call site.
 *
 * Single-user mode: account_cache uses a fixed key ("default") — no IC hashing needed.
 */
import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";

const DB_DIR = process.env.DB_DIR ?? path.resolve(process.cwd(), "../../data");
const DB_PATH = path.join(DB_DIR, "cache.db");
const ACCOUNT_TTL_MS = 5 * 60 * 1000; // 5 min

/** Fixed cache key for the single authenticated user. */
const ACCOUNT_CACHE_KEY = "default";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

function applySchema(d: Database.Database): void {
  // Migration: drop old consumption_cache with start_month/end_month columns
  const cols = d.prepare(`PRAGMA table_info(consumption_cache)`).all() as { name: string }[];
  if (cols.length > 0 && cols.some((c) => c.name === "start_month")) {
    d.exec(`DROP TABLE consumption_cache`);
  }

  d.exec(`
    CREATE TABLE IF NOT EXISTS consumption_cache (
      meter_no      TEXT NOT NULL,
      start_date    TEXT NOT NULL,
      end_date      TEXT NOT NULL,
      response_json TEXT NOT NULL,
      cached_at     INTEGER NOT NULL,
      PRIMARY KEY (meter_no, start_date, end_date)
    );

    CREATE TABLE IF NOT EXISTS topup_cache (
      meter_no      TEXT NOT NULL,
      start_date    TEXT NOT NULL,
      end_date      TEXT NOT NULL,
      response_json TEXT NOT NULL,
      cached_at     INTEGER NOT NULL,
      PRIMARY KEY (meter_no, start_date, end_date)
    );

    CREATE TABLE IF NOT EXISTS account_cache (
      ic_hash       TEXT PRIMARY KEY,
      response_json TEXT NOT NULL,
      cached_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meter_details_cache (
      meter_no      TEXT PRIMARY KEY,
      response_json TEXT NOT NULL,
      cached_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_prompt_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt        TEXT NOT NULL UNIQUE,
      created_at    INTEGER NOT NULL,
      last_used_at  INTEGER NOT NULL
    );

    -- Normalized tables for scheduled scraper
    CREATE TABLE IF NOT EXISTS daily_consumption (
      meter_no    TEXT NOT NULL,
      date        TEXT NOT NULL,
      consumption REAL NOT NULL,
      unit        TEXT NOT NULL,
      scraped_at  INTEGER NOT NULL,
      PRIMARY KEY (meter_no, date)
    );

    CREATE TABLE IF NOT EXISTS topup_transactions (
      transaction_no TEXT PRIMARY KEY,
      meter_no       TEXT NOT NULL,
      topup_date     TEXT NOT NULL,
      topup_amount   REAL NOT NULL,
      debt_cleared   REAL NOT NULL,
      recharge_amount REAL NOT NULL,
      units_credited REAL NOT NULL,
      payment_mode   TEXT NOT NULL,
      site_name      TEXT NOT NULL,
      source         TEXT NOT NULL,
      scraped_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_topup_meter_date ON topup_transactions(meter_no, topup_date);

    CREATE TABLE IF NOT EXISTS meter_snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      meter_no    TEXT NOT NULL,
      meter_type  TEXT NOT NULL,
      status      TEXT NOT NULL,
      balance     REAL NOT NULL,
      remaining_unit REAL NOT NULL,
      unit_label  TEXT NOT NULL,
      full_name   TEXT,
      address     TEXT,
      last_updated TEXT,
      scraped_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshot_meter ON meter_snapshots(meter_no, scraped_at);

    CREATE TABLE IF NOT EXISTS scrape_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at  INTEGER NOT NULL,
      finished_at INTEGER,
      status      TEXT NOT NULL,
      meters_found INTEGER,
      consumption_records INTEGER,
      topup_records INTEGER,
      error_message TEXT,
      trigger     TEXT NOT NULL
    );
  `);
}

// ─── Account cache ──────────────────────────────────────────────────────────

export function getAccountCache(): unknown | null {
  const row = getDb()
    .prepare("SELECT response_json, cached_at FROM account_cache WHERE ic_hash = ?")
    .get(ACCOUNT_CACHE_KEY) as { response_json: string; cached_at: number } | undefined;
  if (!row) return null;
  if (Date.now() - row.cached_at > ACCOUNT_TTL_MS) return null;
  return JSON.parse(row.response_json);
}

export function setAccountCache(data: unknown): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO account_cache (ic_hash, response_json, cached_at) VALUES (?, ?, ?)"
    )
    .run(ACCOUNT_CACHE_KEY, JSON.stringify(data), Date.now());
}

// ─── Meter-details cache ─────────────────────────────────────────────────────

export function getMeterDetailsCache(meterNo: string): unknown | null {
  const row = getDb()
    .prepare("SELECT response_json, cached_at FROM meter_details_cache WHERE meter_no = ?")
    .get(meterNo) as { response_json: string; cached_at: number } | undefined;
  if (!row) return null;
  if (Date.now() - row.cached_at > ACCOUNT_TTL_MS) return null;
  return JSON.parse(row.response_json);
}

export function setMeterDetailsCache(meterNo: string, data: unknown): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO meter_details_cache (meter_no, response_json, cached_at) VALUES (?, ?, ?)"
    )
    .run(meterNo, JSON.stringify(data), Date.now());
}

// ─── Consumption cache ───────────────────────────────────────────────────────

/**
 * Consumption data for a range ending before today is immutable history.
 * Ranges touching today get the same 5-min TTL as account data.
 */
function consumptionIsImmutable(endDate: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  return endDate < today;
}

export function getConsumptionCache(
  meterNo: string,
  startDate: string,
  endDate: string
): unknown | null {
  const row = getDb()
    .prepare(
      "SELECT response_json, cached_at FROM consumption_cache WHERE meter_no = ? AND start_date = ? AND end_date = ?"
    )
    .get(meterNo, startDate, endDate) as
    | { response_json: string; cached_at: number }
    | undefined;
  if (!row) return null;
  if (!consumptionIsImmutable(endDate) && Date.now() - row.cached_at > ACCOUNT_TTL_MS) {
    return null;
  }
  return JSON.parse(row.response_json);
}

export function setConsumptionCache(
  meterNo: string,
  startDate: string,
  endDate: string,
  data: unknown
): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO consumption_cache (meter_no, start_date, end_date, response_json, cached_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(meterNo, startDate, endDate, JSON.stringify(data), Date.now());
}

// ─── Topup cache ─────────────────────────────────────────────────────────────

function topupIsImmutable(endDate: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  return endDate < today;
}

export function getTopupCache(
  meterNo: string,
  startDate: string,
  endDate: string
): unknown | null {
  const row = getDb()
    .prepare(
      "SELECT response_json, cached_at FROM topup_cache WHERE meter_no = ? AND start_date = ? AND end_date = ?"
    )
    .get(meterNo, startDate, endDate) as
    | { response_json: string; cached_at: number }
    | undefined;
  if (!row) return null;
  if (!topupIsImmutable(endDate) && Date.now() - row.cached_at > ACCOUNT_TTL_MS) {
    return null;
  }
  return JSON.parse(row.response_json);
}

export function setTopupCache(
  meterNo: string,
  startDate: string,
  endDate: string,
  data: unknown
): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO topup_cache (meter_no, start_date, end_date, response_json, cached_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(meterNo, startDate, endDate, JSON.stringify(data), Date.now());
}

// ─── AI prompt history ───────────────────────────────────────────────────────

const MAX_PROMPT_HISTORY = 20;

export function getPromptHistory(): { id: number; prompt: string; lastUsedAt: number }[] {
  return getDb()
    .prepare("SELECT id, prompt, last_used_at as lastUsedAt FROM ai_prompt_history ORDER BY last_used_at DESC LIMIT ?")
    .all(MAX_PROMPT_HISTORY) as { id: number; prompt: string; lastUsedAt: number }[];
}

export function savePromptHistory(prompt: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO ai_prompt_history (prompt, created_at, last_used_at) VALUES (?, ?, ?) ON CONFLICT(prompt) DO UPDATE SET last_used_at = ?"
    )
    .run(prompt, now, now, now);
  // Prune old entries beyond limit
  getDb()
    .prepare(
      "DELETE FROM ai_prompt_history WHERE id NOT IN (SELECT id FROM ai_prompt_history ORDER BY last_used_at DESC LIMIT ?)"
    )
    .run(MAX_PROMPT_HISTORY);
}

export function deletePromptHistory(id: number): void {
  getDb().prepare("DELETE FROM ai_prompt_history WHERE id = ?").run(id);
}

// ─── Normalized consumption (from scheduler) ────────────────────────────────────

export interface DailyConsumptionRow {
  meter_no: string;
  date: string;
  consumption: number;
  unit: string;
  scraped_at: number;
}

export function upsertDailyConsumption(rows: DailyConsumptionRow[]): void {
  const stmt = getDb().prepare(`
    INSERT INTO daily_consumption (meter_no, date, consumption, unit, scraped_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(meter_no, date) DO UPDATE SET
      consumption = excluded.consumption,
      unit = excluded.unit,
      scraped_at = excluded.scraped_at
  `);
  for (const row of rows) {
    stmt.run(row.meter_no, row.date, row.consumption, row.unit, row.scraped_at);
  }
}

export function getDailyConsumption(
  meterNo: string,
  startDate: string,
  endDate: string
): DailyConsumptionRow[] {
  return getDb()
    .prepare(
      "SELECT meter_no, date, consumption, unit, scraped_at FROM daily_consumption WHERE meter_no = ? AND date >= ? AND date <= ? ORDER BY date"
    )
    .all(meterNo, startDate, endDate) as DailyConsumptionRow[];
}

// ─── Normalized topup transactions (from scheduler) ──────────────────────────────

export interface TopupTransactionRow {
  transaction_no: string;
  meter_no: string;
  topup_date: string;
  topup_amount: number;
  debt_cleared: number;
  recharge_amount: number;
  units_credited: number;
  payment_mode: string;
  site_name: string;
  source: string;
  scraped_at: number;
}

export function upsertTopupTransactions(rows: TopupTransactionRow[]): void {
  const stmt = getDb().prepare(`
    INSERT INTO topup_transactions
      (transaction_no, meter_no, topup_date, topup_amount, debt_cleared, recharge_amount,
       units_credited, payment_mode, site_name, source, scraped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(transaction_no) DO UPDATE SET
      meter_no = excluded.meter_no,
      topup_date = excluded.topup_date,
      topup_amount = excluded.topup_amount,
      debt_cleared = excluded.debt_cleared,
      recharge_amount = excluded.recharge_amount,
      units_credited = excluded.units_credited,
      payment_mode = excluded.payment_mode,
      site_name = excluded.site_name,
      source = excluded.source,
      scraped_at = excluded.scraped_at
  `);
  for (const row of rows) {
    stmt.run(
      row.transaction_no,
      row.meter_no,
      row.topup_date,
      row.topup_amount,
      row.debt_cleared,
      row.recharge_amount,
      row.units_credited,
      row.payment_mode,
      row.site_name,
      row.source,
      row.scraped_at
    );
  }
}

export function getTopupTransactions(
  meterNo: string,
  startDate: string,
  endDate: string
): TopupTransactionRow[] {
  return getDb()
    .prepare(
      "SELECT transaction_no, meter_no, topup_date, topup_amount, debt_cleared, recharge_amount, units_credited, payment_mode, site_name, source, scraped_at FROM topup_transactions WHERE meter_no = ? AND topup_date >= ? AND topup_date <= ? ORDER BY topup_date DESC"
    )
    .all(meterNo, startDate, endDate) as TopupTransactionRow[];
}

// ─── Meter snapshots (from scheduler) ────────────────────────────────────────────

export interface MeterSnapshotRow {
  id?: number;
  meter_no: string;
  meter_type: string;
  status: string;
  balance: number;
  remaining_unit: number;
  unit_label: string;
  full_name?: string;
  address?: string;
  last_updated?: string;
  scraped_at: number;
}

export function insertMeterSnapshot(row: MeterSnapshotRow): number {
  const result = getDb().prepare(`
    INSERT INTO meter_snapshots
      (meter_no, meter_type, status, balance, remaining_unit, unit_label, full_name, address, last_updated, scraped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.meter_no,
    row.meter_type,
    row.status,
    row.balance,
    row.remaining_unit,
    row.unit_label,
    row.full_name,
    row.address,
    row.last_updated,
    row.scraped_at
  );
  return Number(result.lastInsertRowid);
}

export function getLatestMeterSnapshots(meterNo?: string): MeterSnapshotRow[] {
  if (meterNo) {
    return getDb()
      .prepare(`
        SELECT id, meter_no, meter_type, status, balance, remaining_unit, unit_label,
               full_name, address, last_updated, scraped_at
        FROM meter_snapshots
        WHERE meter_no = ?
        ORDER BY scraped_at DESC
        LIMIT 1
      `)
      .all(meterNo) as MeterSnapshotRow[];
  }
  return getDb()
    .prepare(`
      SELECT id, meter_no, meter_type, status, balance, remaining_unit, unit_label,
             full_name, address, last_updated, scraped_at
      FROM meter_snapshots
      WHERE (meter_no, scraped_at) IN (
        SELECT meter_no, MAX(scraped_at) FROM meter_snapshots GROUP BY meter_no
      )
      ORDER BY meter_no
    `)
    .all() as MeterSnapshotRow[];
}

// ─── Scrape log (from scheduler) ──────────────────────────────────────────────────

export interface ScrapeLogRow {
  id?: number;
  started_at: number;
  finished_at?: number;
  status: "running" | "success" | "error";
  meters_found?: number;
  consumption_records?: number;
  topup_records?: number;
  error_message?: string;
  trigger: "schedule" | "manual" | "startup";
}

export function insertScrapeLog(row: ScrapeLogRow): number {
  const result = getDb().prepare(`
    INSERT INTO scrape_log
      (started_at, finished_at, status, meters_found, consumption_records, topup_records, error_message, trigger)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.started_at,
    row.finished_at ?? null,
    row.status,
    row.meters_found ?? null,
    row.consumption_records ?? null,
    row.topup_records ?? null,
    row.error_message ?? null,
    row.trigger
  );
  return Number(result.lastInsertRowid);
}

export function updateScrapeLog(
  id: number,
  update: Partial<ScrapeLogRow>
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (update.finished_at !== undefined) { sets.push("finished_at = ?"); values.push(update.finished_at); }
  if (update.status !== undefined) { sets.push("status = ?"); values.push(update.status); }
  if (update.meters_found !== undefined) { sets.push("meters_found = ?"); values.push(update.meters_found); }
  if (update.consumption_records !== undefined) { sets.push("consumption_records = ?"); values.push(update.consumption_records); }
  if (update.topup_records !== undefined) { sets.push("topup_records = ?"); values.push(update.topup_records); }
  if (update.error_message !== undefined) { sets.push("error_message = ?"); values.push(update.error_message); }

  if (sets.length === 0) return;
  values.push(id);
  getDb().prepare(`UPDATE scrape_log SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function getLastScrapeLog(): ScrapeLogRow | null {
  const row = getDb()
    .prepare("SELECT * FROM scrape_log ORDER BY started_at DESC LIMIT 1")
    .get() as ScrapeLogRow | undefined;
  return row ?? null;
}

export function getLastSuccessfulScrape(): ScrapeLogRow | null {
  const row = getDb()
    .prepare("SELECT * FROM scrape_log WHERE status = 'success' ORDER BY finished_at DESC LIMIT 1")
    .get() as ScrapeLogRow | undefined;
  return row ?? null;
}
