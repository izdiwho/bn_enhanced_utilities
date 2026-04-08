# PRD: Scheduled Scraper + Predictive Analytics (v2)

## Overview

### Summary
Decouple the Playwright scraper from the request/response cycle into an hourly scheduled job, and add predictive/prescriptive analytics: consumption trend detection, what-if appliance simulator, 7-day forecast, and a consumption anomaly timeline. The dashboard reads from a persistent data store and always loads instantly regardless of scraper health.

### Goals
- Instant page load: dashboard reads from DB only, never blocks on scraping
- Hourly automated data sync with on-demand manual trigger
- Data preservation: build historical record for long-term analysis
- Elevate from descriptive ("what happened") to predictive ("what will happen") and prescriptive ("what to do")

### Non-Goals
- Sub-minute / real-time data (USMS only updates daily)
- Appliance signature detection from power draw patterns (needs sub-minute data USMS doesn't provide)
- Time-of-use tariff optimization (Brunei has flat-rate tiered pricing, no peak/off-peak)
- Multi-user support (single household, single set of credentials)
- Separate microservice deployment (keep single Docker Compose for simplicity)

---

## Context

### Current State
- Scraping happens on every API request when cache is cold (10-30s Playwright launch + navigation)
- SQLite cache stores results per (meter, startDate, endDate) key with TTL rules
- If USMS is down or the scraper breaks, the dashboard appears broken to the user
- No data older than what the user manually requests (no proactive data collection)
- Analytics are purely descriptive (summaries, comparisons, anomaly flags)

### Problem Statement
1. **Cold starts are painful**: first load after restart takes 20-30s. Switching meters or date ranges can trigger new scrapes.
2. **No data resilience**: if the scraper breaks (USMS UI change, DevExpress update), the dashboard is useless.
3. **No long-term history**: data only exists for ranges the user has requested. No year-over-year analysis.
4. **Missing actionable insights**: users see what happened but not what to do about it.

### User Stories
- As a user, I want the dashboard to load instantly with fresh data so I don't wait 20 seconds on every visit
- As a user, I want to see my data even when the SmartMeter portal is temporarily down
- As a user, I want to manually trigger a data refresh when I've just topped up
- As a user, I want to see a 7-day consumption forecast so I can plan my top-up timing
- As a user, I want "what-if" scenarios for appliance changes so I can make cost-effective decisions
- As a user, I want to see if my consumption is trending up or down over time

---

## Technical Specification

### Architecture Overview

```
                    ┌─────────────────────────┐
                    │   Scheduled Scraper      │
                    │   (node-cron, hourly)    │
                    │                          │
                    │  ┌───────────────────┐   │
                    │  │ Playwright Browser│   │
                    │  └────────┬──────────┘   │
                    │           │              │
                    │  ┌────────▼──────────┐   │
                    │  │ Data Normalizer   │   │
                    │  └────────┬──────────┘   │
                    └───────────┼──────────────┘
                                │
                    ┌───────────▼──────────────┐
                    │  SQLite (persistent)      │
                    │  ┌─────────────────────┐  │
                    │  │ daily_consumption   │  │
                    │  │ topup_transactions  │  │
                    │  │ meter_snapshots     │  │
                    │  │ scrape_log          │  │
                    │  └─────────────────────┘  │
                    └───────────┬──────────────┘
                                │
┌───────────────┐   ┌───────────▼──────────────┐
│   Browser     │──▶│  Express API             │
│   (React)     │   │  (reads from DB only)    │
│               │◀──│  + analytics engine      │
└───────────────┘   └──────────────────────────┘
```

**Key change**: API routes never call the scraper directly. They read from normalized tables. The scraper runs independently on a schedule.

### Data Models

**New normalized tables** (replace the cache tables for consumption and topup):

```sql
-- Daily consumption records (one row per meter per day)
CREATE TABLE daily_consumption (
  meter_no    TEXT NOT NULL,
  date        TEXT NOT NULL,   -- YYYY-MM-DD
  consumption REAL NOT NULL,   -- kWh or m³
  unit        TEXT NOT NULL,   -- "kWh" or "m³"
  scraped_at  INTEGER NOT NULL,
  PRIMARY KEY (meter_no, date)
);

-- Top-up transactions (one row per transaction)
CREATE TABLE topup_transactions (
  transaction_no TEXT PRIMARY KEY,
  meter_no       TEXT NOT NULL,
  topup_date     TEXT NOT NULL,   -- YYYY-MM-DD
  topup_amount   REAL NOT NULL,
  debt_cleared   REAL NOT NULL,
  recharge_amount REAL NOT NULL,
  units_credited REAL NOT NULL,
  payment_mode   TEXT NOT NULL,
  site_name      TEXT NOT NULL,
  source         TEXT NOT NULL,
  scraped_at     INTEGER NOT NULL
);
CREATE INDEX idx_topup_meter_date ON topup_transactions(meter_no, topup_date);

-- Meter snapshots (balance + remaining units, captured each scrape)
CREATE TABLE meter_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  meter_no    TEXT NOT NULL,
  meter_type  TEXT NOT NULL,    -- "electricity" or "water"
  status      TEXT NOT NULL,
  balance     REAL NOT NULL,    -- BND
  remaining_unit REAL NOT NULL, -- kWh or m³
  unit_label  TEXT NOT NULL,
  full_name   TEXT,
  address     TEXT,
  last_updated TEXT,            -- from USMS portal
  scraped_at  INTEGER NOT NULL
);
CREATE INDEX idx_snapshot_meter ON meter_snapshots(meter_no, scraped_at);

-- Scrape execution log
CREATE TABLE scrape_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT NOT NULL,    -- "running", "success", "error"
  meters_found INTEGER,
  consumption_records INTEGER,
  topup_records INTEGER,
  error_message TEXT,
  trigger     TEXT NOT NULL     -- "schedule", "manual", "startup"
);
```

### API Endpoints

**Existing endpoints** — change to read from normalized tables:

| Method | Endpoint | Change |
|--------|----------|--------|
| GET | `/api/config` | Add `lastScrape: { at, status }` to response |
| POST | `/api/consumption-history` | Read from `daily_consumption` table, no scraping |
| POST | `/api/topup-history` | Read from `topup_transactions` table, no scraping |
| POST | `/api/account` | Read latest `meter_snapshots`, no scraping |

**New endpoints**:

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/scrape/trigger` | Manually trigger a scrape. Returns `{ jobId, status: "started" }` |
| GET | `/api/scrape/status` | Returns current scrape status + last scrape info |
| GET | `/api/analytics/forecast` | 7-day consumption forecast for a meter |
| GET | `/api/analytics/trend` | Consumption trend analysis (is usage going up/down?) |
| POST | `/api/analytics/what-if` | What-if appliance simulation |

### Scraper Job Design

**File**: `backend/src/scraper/scheduler.ts`

```typescript
interface ScrapeJob {
  trigger: "schedule" | "manual" | "startup";
  status: "running" | "success" | "error";
  startedAt: number;
  finishedAt?: number;
  error?: string;
}
```

**Hourly schedule** (via `node-cron`):
- Runs at minute 0 of every hour: `0 * * * *`
- On startup: run immediately if last successful scrape > 1 hour ago
- Manual trigger via `/api/scrape/trigger` (debounced — ignores if scrape is already running)
- Scrape all meters: consumption for current month + topups for last 365 days
- Insert/upsert into normalized tables
- Log each run in `scrape_log`

**Scrape sequence per run**:
1. Login (reuse existing `session.ts` singleton)
2. Fetch Home page → parse meter list → upsert `meter_snapshots`
3. For each meter:
   a. Fetch daily consumption for current month → upsert `daily_consumption`
   b. Fetch daily consumption for previous month (if not fully scraped yet) → upsert
   c. Fetch topup transactions for last 365 days → upsert `topup_transactions`
4. Log result in `scrape_log`

**Error handling**:
- If login fails → log error, skip all meters, retry next hour
- If one meter fails → log warning, continue with next meter
- Session expired mid-scrape → re-login, retry current meter
- Playwright crash → log error, cleanup browser, retry next hour

### Analytics Engine

**File**: `backend/src/analytics/`

#### 1. Consumption Trend Detection (`trend.ts`)

```typescript
interface TrendAnalysis {
  period: "7d" | "30d" | "90d";
  direction: "up" | "down" | "stable";
  changePercent: number;         // e.g. +12.5 or -8.3
  currentAvgDaily: number;       // kWh/day recent
  previousAvgDaily: number;      // kWh/day comparison period
  insight: string;               // "Your daily average increased 12% vs last month"
}
```

Algorithm: compare rolling average of last N days vs previous N days. Simple, no ML needed.

#### 2. 7-Day Forecast (`forecast.ts`)

```typescript
interface ForecastDay {
  date: string;                  // YYYY-MM-DD
  predicted: number;             // kWh
  lower: number;                 // 80% confidence interval
  upper: number;
}

interface Forecast {
  meter_no: string;
  days: ForecastDay[];
  method: "ema";                 // exponential moving average
  basedOnDays: number;           // how many historical days used
}
```

Algorithm: Exponential Moving Average (EMA) with day-of-week seasonality.
1. Compute 14-day EMA as baseline
2. Compute day-of-week adjustment factor (e.g. Sundays average 15% above baseline)
3. Forecast = EMA × day-of-week-factor
4. Confidence interval: ±1.5 standard deviations of recent daily variance

This is simple, robust, and doesn't need external ML libraries.

#### 3. What-If Simulator (`whatif.ts`)

```typescript
interface WhatIfScenario {
  description: string;           // "Replace 2hp non-inverter AC with inverter"
  currentKwhPerMonth: number;    // from AI estimator or manual input
  projectedKwhPerMonth: number;  // estimated after change
  monthlySavingsBnd: number;
  annualSavingsBnd: number;
  upgradeCostBnd?: number;       // if provided
  paybackMonths?: number;        // upgradeCost / monthlySavings
}
```

**Predefined scenarios** (data-driven, no AI call needed):
- "Replace non-inverter AC with inverter" → 30-40% reduction on that appliance's draw
- "Reduce AC runtime by 2 hours/day" → proportional reduction
- "Switch to LED lighting" → known wattage differences
- "Add solar water heater" → eliminate electric water heater draw

The simulator uses the AI appliance breakdown as input (already have it), applies known efficiency multipliers, and calculates cost impact via the tariff engine.

### File Structure

```
backend/src/
├── scraper/
│   ├── browser.ts          (existing — Playwright scraper)
│   ├── scheduler.ts        (NEW — cron job + manual trigger)
│   ├── normalizer.ts       (NEW — raw scrape data → normalized tables)
│   ├── client.ts           (existing)
│   ├── login.ts            (existing)
│   ├── mainPage.ts         (existing)
│   ├── parsers.ts          (existing)
│   └── reports.ts          (existing)
├── analytics/
│   ├── trend.ts            (NEW — trend detection)
│   ├── forecast.ts         (NEW — 7-day EMA forecast)
│   └── whatif.ts           (NEW — what-if simulator)
├── routes/
│   ├── usms.ts             (MODIFY — read from normalized tables)
│   ├── scrape.ts           (NEW — /api/scrape/* endpoints)
│   ├── analytics.ts        (NEW — /api/analytics/* endpoints)
│   ├── ai.ts               (existing)
│   ├── auth.ts             (MODIFY — add lastScrape to /api/config)
│   └── pin.ts              (existing)
├── cache.ts                (MODIFY — add normalized tables + keep existing cache)
├── session.ts              (existing)
└── index.ts                (MODIFY — start scheduler)

frontend/src/components/
├── Dashboard.tsx           (MODIFY — add scrape status indicator, forecast section)
├── ScrapeStatus.tsx        (NEW — "Last synced 45 min ago" + manual refresh)
├── ForecastChart.tsx       (NEW — 7-day forecast bars with confidence band)
├── TrendIndicator.tsx      (NEW — "↑ 12% vs last month" inline component)
├── WhatIfSimulator.tsx     (NEW — appliance swap calculator)
└── ... (existing components unchanged)
```

---

## Implementation Plan

### Phase 1: Scheduled Scraper (foundation)
- [ ] Add `node-cron` dependency
- [ ] Create normalized SQLite tables (`daily_consumption`, `topup_transactions`, `meter_snapshots`, `scrape_log`)
- [ ] Build `normalizer.ts` — transform raw scrape output into normalized rows (upsert)
- [ ] Build `scheduler.ts` — cron job that runs the full scrape sequence hourly
- [ ] Add `POST /api/scrape/trigger` and `GET /api/scrape/status` endpoints
- [ ] Run scraper on startup if last success > 1 hour ago
- [ ] Modify `/api/consumption-history` to read from `daily_consumption` table
- [ ] Modify `/api/topup-history` to read from `topup_transactions` table
- [ ] Modify `/api/account` to read latest `meter_snapshots`
- [ ] Modify `/api/config` to include `lastScrape` status
- [ ] Frontend: add `ScrapeStatus` component (last sync time + manual refresh button)
- [ ] Keep existing cache tables for backward compat during migration

### Phase 2: Predictive Analytics
- [ ] Build `trend.ts` — rolling average comparison, trend direction, % change
- [ ] Build `forecast.ts` — 7-day EMA forecast with day-of-week seasonality
- [ ] Add `GET /api/analytics/forecast?meterNo=X` endpoint
- [ ] Add `GET /api/analytics/trend?meterNo=X&period=30d` endpoint
- [ ] Frontend: `ForecastChart` — 7 forecast bars (lighter color) appended after actual data
- [ ] Frontend: `TrendIndicator` — inline "↑ 12% vs last month" shown in Overview section

### Phase 3: What-If Simulator
- [ ] Build `whatif.ts` — predefined scenarios with efficiency multipliers
- [ ] Add `POST /api/analytics/what-if` endpoint
- [ ] Frontend: `WhatIfSimulator` — dropdown of scenarios + custom input, shows savings + payback
- [ ] Integrate with existing AI appliance breakdown as input data

### Dependencies & Order
Phase 1 must complete before Phase 2 (forecast needs normalized historical data). Phase 3 can start in parallel with Phase 2 (what-if only needs the AI breakdown, not the forecast).

---

## Security Considerations

- [ ] `POST /api/scrape/trigger` must be behind PIN auth (already handled by `pinGuard` middleware)
- [ ] Scrape log should not expose USMS credentials or session tokens
- [ ] Rate-limit manual scrape trigger (max 1 per 5 minutes)
- [ ] Forecast/analytics endpoints are read-only, low risk

---

## Testing Strategy

### Unit Tests
- `normalizer.ts` — transform raw ConsumptionRecord/TopUpRecord into normalized rows
- `trend.ts` — trend detection with known datasets (increasing, decreasing, stable)
- `forecast.ts` — EMA calculation, day-of-week factors, confidence interval
- `whatif.ts` — savings calculations with known inputs

### Integration Tests
- Scheduler: mock scraper, verify normalized tables populated correctly
- API endpoints: verify they read from normalized tables, not cache
- Manual trigger: verify debounce (no concurrent scrapes)

### Manual Testing
- Start app → verify scrape runs on startup
- Wait 1 hour → verify cron fires
- Kill USMS session → verify dashboard still shows cached data
- Click manual refresh → verify scrape triggers and data updates

---

## Configuration & Environment

### New Environment Variables
| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `SCRAPE_INTERVAL_CRON` | Cron expression for scrape schedule | No | `0 * * * *` (hourly) |
| `SCRAPE_ON_STARTUP` | Run scrape on backend startup | No | `true` |
| `SCRAPE_CONSUMPTION_MONTHS` | How many months back to scrape consumption | No | `3` |
| `SCRAPE_TOPUP_DAYS` | How many days back to scrape topups | No | `365` |

### Docker Changes
- No new services needed (scheduler runs inside the existing backend process)
- May want to increase memory limit if scraper + API server + scheduler all run concurrently

---

## Open Questions

- [ ] Should historical data be exportable (CSV/JSON download)? Would be easy to add.
- [ ] Should the scraper backfill old months on first run? (Could scrape month-by-month going back 6-12 months to seed the history.)
- [ ] Should forecast confidence intervals be configurable, or is 80% fine?
- [ ] Should the what-if simulator include appliance cost data (for payback calculation), or just show kWh/BND savings?

---

## Success Criteria

- [ ] Dashboard loads in < 1s (no scraping on page load)
- [ ] Data updates automatically every hour without user action
- [ ] Manual "Refresh" button triggers a scrape and updates data within 60s
- [ ] If scraper is broken, dashboard shows last successful data + "Last synced X hours ago" warning
- [ ] 7-day forecast renders with confidence band
- [ ] Trend detection correctly identifies ≥10% change as "up" or "down"
- [ ] What-if simulator shows savings for at least 3 predefined scenarios
- [ ] All existing features continue to work (no regressions)

---

## References

- Current codebase: `backend/src/scraper/`, `backend/src/cache.ts`, `frontend/src/components/Dashboard.tsx`
- node-cron: https://www.npmjs.com/package/node-cron
- Exponential Moving Average: standard signal processing, no external library needed
- Brunei electricity tariff tiers: `frontend/src/utils/tariff.ts`
