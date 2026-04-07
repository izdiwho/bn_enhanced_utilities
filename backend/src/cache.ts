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
