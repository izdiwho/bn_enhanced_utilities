/**
 * Dashboard — main view.
 *
 * Layout (Kampong Grid — Tropical Infrastructure dark theme):
 *   Header: app title small-caps + meter type label, understated
 *   Meter selector tabs — left-indicator style (4px square), no underline
 *
 * Section order (most actionable first):
 *   OVERVIEW   — Summary stats (4 key numbers)
 *   CONSUMPTION — Date range picker + toggles (same row) → Chart
 *   FORECAST   — BalanceForecast + CostProjection (2-col grid)
 *   INSIGHTS   — UsagePatterns + AnomalyDetector (2-col grid)
 *               WeatherCorrelation (full width, only when weather loaded)
 *   TOOLS      — ApplianceEstimator / WaterTankEstimator
 *
 * "Last 3 Months" fires 3 parallel API calls and merges the results.
 * Weather data is fetched from Open-Meteo when the Weather toggle is active.
 * Mobile responsive at 375px.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { ConsumptionChart } from "./ConsumptionChart.js";
import { ChartToggles, defaultOverlayState, type ChartOverlayState } from "./ChartToggles.js";
import { SummaryStats } from "./SummaryStats.js";
import { BalanceForecast } from "./BalanceForecast.js";
import { ApplianceEstimator } from "./ApplianceEstimator.js";
import { WaterTankEstimator } from "./WaterTankEstimator.js";
import { UsagePatterns } from "./UsagePatterns.js";
import { AnomalyDetector } from "./AnomalyDetector.js";
import { CostProjection } from "./CostProjection.js";
import { TariffTierTracker } from "./TariffTierTracker.js";
import { BillComparison } from "./BillComparison.js";
import { TopUpEfficiency } from "./TopUpEfficiency.js";
import {
  ConsumptionRangePicker,
  getThisMonthRange,
  getLast3MonthRanges,
  type ConsumptionDateRange,
} from "./DateRangePicker.js";
import { getConsumptionHistory, getTopupHistory } from "../api/usms.js";
import { fetchWeatherData } from "../api/weather.js";
import type { Meter, ConsumptionRecord, TopUpRecord, WeatherData } from "../types/usms.js";

interface DashboardProps {
  meters: Meter[];
  features: { ai: boolean };
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded ${className}`}
      style={{ background: "var(--bg-raised)" }}
    />
  );
}

function ChartSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-3 w-1/4" />
      <Skeleton className="h-80 w-full" />
    </div>
  );
}

// ─── Meter tab ────────────────────────────────────────────────────────────────

interface MeterTabProps {
  meter: Meter;
  active: boolean;
  onClick: () => void;
}

function MeterTab({ meter, active, onClick }: MeterTabProps) {
  const isElec = meter.meterType === "electricity";
  const activeColor = isElec ? "var(--color-electricity)" : "var(--color-water)";

  return (
    <button
      onClick={onClick}
      className="pb-3 transition-colors relative flex items-center gap-2 shrink-0"
      style={{
        color: active ? "var(--text-primary)" : "var(--text-tertiary)",
        fontWeight: active ? 500 : 400,
        fontSize: "13px",
        minHeight: "44px",
      }}
    >
      {/* 4px square indicator to the left when active */}
      <span
        style={{
          display: "inline-block",
          width: "4px",
          height: "4px",
          flexShrink: 0,
          background: active ? activeColor : "transparent",
        }}
      />
      <span style={{ fontWeight: 600 }}>{isElec ? "Electricity" : "Water"}</span>
      <span
        style={{
          fontWeight: 400,
          color: active ? "var(--text-secondary)" : "var(--text-tertiary)",
          opacity: 0.7,
        }}
      >
        · {meter.meterNo}
      </span>
      {meter.remainingBalance != null && (
        <span
          className="font-mono ml-1"
          style={{
            fontSize: "12px",
            color: "var(--text-tertiary)",
          }}
        >
          ${meter.remainingBalance.toFixed(2)}
        </span>
      )}
    </button>
  );
}

// ─── Section group wrapper ────────────────────────────────────────────────────

interface SectionGroupProps {
  label: string;
  children: React.ReactNode;
  first?: boolean;
}

function SectionGroup({ label, children, first = false }: SectionGroupProps) {
  return (
    <div
      style={{
        borderTop: first ? "none" : "1px solid var(--border-subtle)",
        paddingTop: first ? 0 : "2rem",
      }}
    >
      <div className="flex items-center gap-3 mb-5">
        <p
          className="font-sans font-medium uppercase shrink-0"
          style={{
            color: "var(--text-tertiary)",
            fontSize: "11px",
            letterSpacing: "0.13em",
          }}
        >
          {label}
        </p>
        <div
          className="flex-grow"
          style={{ borderBottom: "1px solid var(--border-subtle)" }}
        />
      </div>
      {children}
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

interface MeterPanelProps {
  meter: Meter;
  features: { ai: boolean };
}

function MeterPanel({ meter, features }: MeterPanelProps) {
  const [dateRange, setDateRange] = useState<ConsumptionDateRange>(getThisMonthRange);
  const [records, setRecords]     = useState<ConsumptionRecord[]>([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [warning, setWarning]     = useState<string | undefined>();
  // Shared topup data — auto-loads from cache on mount, manual refresh available
  const [topupRecords, setTopupRecords] = useState<TopUpRecord[] | null>(null); // null = not loaded yet
  const [topupLoading, setTopupLoading] = useState(false);
  const [topupEverLoaded, setTopupEverLoaded] = useState(false);
  const [overlays, setOverlays]   = useState<ChartOverlayState>(defaultOverlayState);
  const [weatherData, setWeatherData] = useState<WeatherData | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  // AI baseline: daily kWh derived from ApplianceEstimator (monthly / 30)
  const [aiDailyKwh, setAiDailyKwh] = useState<number | null>(null);
  const [aiDailyMin, setAiDailyMin] = useState<number | null>(null);
  const [aiDailyMax, setAiDailyMax] = useState<number | null>(null);

  // Track the current fetch so we can ignore stale results
  const fetchIdRef = useRef(0);

  // Fetch topup history — tries cache first (instant), or scrapes (~20s)
  const loadTopups = useCallback(async (force = false) => {
    setTopupLoading(true);
    try {
      const today = new Date();
      const start = new Date(today);
      start.setDate(today.getDate() - 365);
      const fmt = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const res = await getTopupHistory(meter.meterNo, fmt(start), fmt(today), force);
      setTopupRecords(res.records);
      setTopupEverLoaded(true);
    } catch {
      // Don't set to empty array on initial silent probe — leave as null so button shows
      if (topupEverLoaded) setTopupRecords([]);
    } finally {
      setTopupLoading(false);
    }
  }, [meter.meterNo, topupEverLoaded]);

  // On mount: try loading from cache (no force). If backend has cached data, instant.
  // If not cached, this will trigger a scrape — show loading state.
  useEffect(() => { loadTopups(false); }, [loadTopups]);

  const loadConsumption = useCallback(
    async (range: ConsumptionDateRange) => {
      const fetchId = ++fetchIdRef.current;
      setLoading(true);
      setError(null);
      setRecords([]);
      setWarning(undefined);

      try {
        if (range.preset === "last3Months") {
          // Fire 3 parallel API calls — one per calendar month
          const ranges = getLast3MonthRanges();
          const results = await Promise.all(
            ranges.map((r) =>
              getConsumptionHistory(
                meter.meterNo,
                r.startDate,
                r.endDate
              ).catch(() => ({ records: [], warning: "partial_data" as string | undefined, fromCache: false }))
            )
          );
          if (fetchId !== fetchIdRef.current) return;
          const merged = results.flatMap((r) => r.records);
          // Sort chronologically by period
          merged.sort((a, b) => a.period.localeCompare(b.period));
          setRecords(merged);
          const warnings = results.map((r) => r.warning).filter(Boolean);
          if (warnings.length > 0) setWarning("partial_data");
        } else {
          const res = await getConsumptionHistory(
            meter.meterNo,
            range.startDate,
            range.endDate
          );
          if (fetchId !== fetchIdRef.current) return;
          setRecords(res.records);
          setWarning(res.warning);
        }
      } catch (err) {
        if (fetchId !== fetchIdRef.current) return;
        setError(err instanceof Error ? err.message : "Failed to load consumption data.");
      } finally {
        if (fetchId === fetchIdRef.current) setLoading(false);
      }
    },
    [meter.meterNo]
  );

  // Load weather when Weather toggle is turned on or date range changes while active
  useEffect(() => {
    if (!overlays.showWeather || records.length === 0) {
      if (!overlays.showWeather) setWeatherData(null);
      return;
    }
    let cancelled = false;
    setWeatherLoading(true);
    const start = records[0].period;
    const end   = records[records.length - 1].period;
    fetchWeatherData(start, end).then((data) => {
      if (!cancelled) {
        setWeatherData(data);
        setWeatherLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [overlays.showWeather, records]);

  useEffect(() => {
    loadConsumption(dateRange);
  }, [loadConsumption, dateRange]);

  function handleRangeChange(range: ConsumptionDateRange) {
    setDateRange(range);
  }

  function handleToggle(key: keyof ChartOverlayState) {
    // Hide AI Baseline toggle if AI features are not available
    if (key === "showAiBaseline" && !features.ai) return;
    setOverlays((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function handleCleanView() {
    setOverlays(defaultOverlayState());
    setWeatherData(null);
  }

  const anyActive =
    overlays.showWeekends ||
    overlays.showHolidays ||
    overlays.showSchool   ||
    overlays.showWeather  ||
    overlays.showAiBaseline;

  const hasInsights = !loading && records.length > 0;

  function handleRefreshAll() {
    loadConsumption(dateRange);
    // Force-refresh topups (bypass cache)
    if (topupRecords !== null) loadTopups(true);
  }

  return (
    <div className="space-y-8">

      {/* ── OVERVIEW: Summary stats + balance ──────────────────────────────── */}
      <SectionGroup label="Overview" first>
        {/* Balance + remaining units + refresh — stacks vertically on mobile */}
        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-4 sm:gap-6 mb-6">
          <div className="flex gap-6 sm:contents">
            <div>
              <p className="font-sans uppercase mb-1" style={{ fontSize: "11px", letterSpacing: "0.1em", color: "var(--text-tertiary)" }}>
                Balance
              </p>
              <p className="font-mono font-bold" style={{ fontSize: "28px", color: "var(--text-primary)", lineHeight: 1 }}>
                <span style={{ fontSize: "16px", fontWeight: 400, color: "var(--text-secondary)" }}>BND </span>
                {meter.remainingBalance.toFixed(2)}
              </p>
            </div>
            <div>
              <p className="font-sans uppercase mb-1" style={{ fontSize: "11px", letterSpacing: "0.1em", color: "var(--text-tertiary)" }}>
                Remaining
              </p>
              <p className="font-mono font-bold" style={{ fontSize: "28px", color: "var(--text-primary)", lineHeight: 1 }}>
                {meter.remainingUnit.toFixed(2)}
                <span style={{ fontSize: "16px", fontWeight: 400, color: "var(--text-secondary)" }}> {meter.remainingUnitLabel}</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 sm:self-end sm:mb-1 sm:ml-auto">
            {meter.lastUpdated && (
              <p className="font-mono" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                Updated {new Date(meter.lastUpdated).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
              </p>
            )}
            <button
              onClick={handleRefreshAll}
              disabled={loading}
              className="font-sans font-medium transition-colors disabled:opacity-40"
              style={{
                fontSize: "11px",
                color: "var(--accent-primary)",
                letterSpacing: "0.05em",
                minHeight: "44px",
                display: "flex",
                alignItems: "center",
              }}
            >
              {loading ? "Refreshing..." : "Refresh ↻"}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex gap-0">
            {[0,1,2,3].map((i) => <Skeleton key={i} className="h-16 flex-1 mx-2" />)}
          </div>
        ) : (
          <SummaryStats
            records={records}
            unitLabel={meter.remainingUnitLabel}
            meterType={meter.meterType}
          />
        )}
        {!loading && records.length > 0 && (
          <div style={{ marginTop: "1.5rem" }}>
            <TariffTierTracker records={records} meterType={meter.meterType} />
          </div>
        )}
      </SectionGroup>

      {/* ── FORECAST: BalanceForecast + CostProjection + TopUpEfficiency ── */}
      {hasInsights && (
        <SectionGroup label="Forecast">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-8">
            <BalanceForecast
              meter={meter}
              consumptionRecords={records}
              topupRecords={topupRecords ?? []}
            />
            <CostProjection
              records={records}
              meterType={meter.meterType}
              dateRange={dateRange}
            />
          </div>

          {/* Top-up history — loaded on demand */}
          <div style={{ marginTop: "1.5rem", borderTop: "1px solid var(--border-subtle)", paddingTop: "1.5rem" }}>
            {topupRecords === null ? (
              <div className="flex items-center gap-3">
                {topupLoading ? (
                  <span className="font-sans text-xs animate-pulse" style={{ color: "var(--text-tertiary)" }}>
                    Loading top-up history...
                  </span>
                ) : (
                  <>
                    <button
                      onClick={() => loadTopups(true)}
                      className="font-sans font-medium transition-colors"
                      style={{
                        fontSize: "12px",
                        color: "var(--accent-primary)",
                        padding: "6px 16px",
                        border: "1px solid var(--accent-primary)",
                        borderRadius: "999px",
                        background: "transparent",
                      }}
                    >
                      Load top-up history
                    </button>
                    <span className="font-sans" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                      Takes ~20s (scrapes the portal)
                    </span>
                  </>
                )}
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-3">
                  <span />
                  <button
                    onClick={() => loadTopups(true)}
                    disabled={topupLoading}
                    className="font-sans transition-colors disabled:opacity-50"
                    style={{ fontSize: "11px", color: "var(--text-tertiary)" }}
                  >
                    {topupLoading ? "Refreshing..." : "Refresh top-up data ↻"}
                  </button>
                </div>
                <TopUpEfficiency meter={meter} consumptionRecords={records} topupRecords={topupRecords} />
              </>
            )}
          </div>
        </SectionGroup>
      )}

      {/* ── CONSUMPTION: Controls row + Chart ──────────────────────────────── */}
      <SectionGroup label="Consumption">
        {/* Date range + toggles on the same flex row, wraps on mobile */}
        <div
          className="flex flex-wrap items-center gap-x-6 gap-y-3 mb-5 px-3 py-2.5 rounded"
          style={{
            background: anyActive ? "var(--bg-surface)" : "transparent",
            border: anyActive ? "1px solid var(--border-subtle)" : "1px solid transparent",
            transition: "background 0.2s, border-color 0.2s",
          }}
        >
          <ConsumptionRangePicker value={dateRange} onChange={handleRangeChange} />

          {/* Vertical divider — hidden on mobile where flex wraps */}
          <span
            className="hidden sm:block self-stretch"
            style={{ width: "1px", background: "var(--border-subtle)", flexShrink: 0 }}
          />

          <ChartToggles
            state={overlays}
            onToggle={handleToggle}
            onCleanView={handleCleanView}
            aiBaselineAvailable={features.ai && aiDailyKwh != null}
            aiEnabled={features.ai}
          />

        </div>

        {/* Chart — hero element */}
        {error ? (
          <div
            className="p-4 flex items-start justify-between gap-3"
            style={{ borderBottom: "1px solid var(--color-holiday)", opacity: 0.8 }}
          >
            <p className="font-sans text-sm" style={{ color: "var(--color-holiday)" }}>{error}</p>
            <button
              onClick={() => loadConsumption(dateRange)}
              className="shrink-0 font-sans text-xs font-medium"
              style={{ color: "var(--color-holiday)" }}
            >
              Retry
            </button>
          </div>
        ) : loading ? (
          <ChartSkeleton />
        ) : (
          <ConsumptionChart
            records={records}
            unitLabel={meter.remainingUnitLabel}
            meterType={meter.meterType}
            warning={warning}
            loading={false}
            overlays={overlays}
            weatherData={weatherLoading ? null : weatherData}
            dailyBaselineKwh={aiDailyKwh}
            dailyBaselineMin={aiDailyMin}
            dailyBaselineMax={aiDailyMax}
          />
        )}
      </SectionGroup>

      {/* ── INSIGHTS: BillComparison, UsagePatterns + AnomalyDetector (2-col) ── */}
      {hasInsights && (
        <SectionGroup label="Insights">
          <BillComparison
            records={records}
            meterType={meter.meterType}
            unitLabel={meter.remainingUnitLabel}
            dateRange={dateRange}
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mt-8 mb-8">
            <UsagePatterns records={records} />
            <AnomalyDetector records={records} meterType={meter.meterType} unitLabel={meter.remainingUnitLabel} />
          </div>
        </SectionGroup>
      )}

      {/* ── TOOLS: ApplianceEstimator / WaterTankEstimator ──────────────────── */}
      {(meter.meterType === "electricity" && features.ai) || meter.meterType === "water" ? (
        <SectionGroup label="Tools">
          {meter.meterType === "electricity" && features.ai && (
            <ApplianceEstimator
              consumptionRecords={records}
              onBaselineEstimated={(mid, min, max) => {
                setAiDailyKwh(mid / 30);
                setAiDailyMin(min / 30);
                setAiDailyMax(max / 30);
              }}
            />
          )}
          {meter.meterType === "water" && (
            <WaterTankEstimator consumptionRecords={records} />
          )}
        </SectionGroup>
      ) : null}

    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export function Dashboard({ meters, features }: DashboardProps) {
  const [selectedMeterNo, setSelectedMeterNo] = useState<string>(
    meters[0]?.meterNo ?? ""
  );

  const selectedMeter = meters.find((m) => m.meterNo === selectedMeterNo) ?? meters[0];
  const isElec = selectedMeter?.meterType === "electricity";

  return (
    <div className="min-h-screen" style={{ background: "var(--bg-deep)", color: "var(--text-primary)" }}>
      {/* Header */}
      <header style={{ borderBottom: "1px solid var(--border-subtle)" }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-5 py-4 sm:py-5">
          <div>
            <h1
              className="font-sans font-semibold"
              style={{
                color: "var(--text-primary)",
                fontSize: "14px",
                letterSpacing: "0.2em",
                textTransform: "uppercase",
              }}
            >
              Utilities Tracker
            </h1>
            <p
              className="font-sans mt-0.5"
              style={{ color: "var(--text-tertiary)", fontSize: "11px" }}
            >
              {selectedMeter
                ? `${isElec ? "Electricity" : "Water"} meter · ${selectedMeter.meterNo}`
                : "Utilities Tracker"}
            </p>
          </div>
        </div>
        {/* Thin rule below header text */}
        <div style={{ borderTop: "1px solid var(--border-subtle)" }} />
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-8">
        {/* Meter selector tabs */}
        {meters.length > 1 && (
          <div
            className="flex gap-4 sm:gap-6 overflow-x-auto"
            style={{ borderBottom: "1px solid var(--border-subtle)" }}
          >
            {meters.map((meter) => (
              <MeterTab
                key={meter.meterNo}
                meter={meter}
                active={meter.meterNo === selectedMeterNo}
                onClick={() => setSelectedMeterNo(meter.meterNo)}
              />
            ))}
          </div>
        )}

        {/* Per-meter detail panel */}
        {selectedMeter && (
          <MeterPanel
            key={selectedMeter.meterNo}
            meter={selectedMeter}
            features={features}
          />
        )}
      </main>
    </div>
  );
}
