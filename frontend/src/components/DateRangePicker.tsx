/**
 * DateRangePicker — day-level date range picker for daily consumption history.
 *
 * Presets (consumption):
 *   "This month"    — 1st of current month → today
 *   "Last month"    — 1st of previous month → last day of previous month
 *   "Last 3 months" — signals Dashboard to fire 3 separate monthly API calls
 *   "Custom"        — date inputs, max 31 days
 *
 * TopupRangePicker (unchanged) handles top-up history date ranges.
 */
import { useState } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Legacy month-range type kept for TopupRangePicker compatibility */
export interface MonthRange {
  startMonth: string; // "YYYY-MM"
  endMonth: string;   // "YYYY-MM"
}

export interface DateRange {
  startDate: string; // "YYYY-MM-DD"
  endDate: string;   // "YYYY-MM-DD"
}

export type ConsumptionPreset = "thisMonth" | "lastMonth" | "last3Months" | "custom";

export interface ConsumptionDateRange extends DateRange {
  preset: ConsumptionPreset;
}

interface ConsumptionRangePickerProps {
  value: ConsumptionDateRange;
  onChange: (range: ConsumptionDateRange) => void;
}

interface TopupRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toYYYYMMDD(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Last day of the given month (0-indexed) */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

export function getThisMonthRange(): ConsumptionDateRange {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  // If yesterday is in the previous month (i.e. today is the 1st), fall back to last month
  if (yesterday.getMonth() !== now.getMonth()) {
    return getLastMonthRange();
  }
  return {
    startDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`,
    endDate:   toYYYYMMDD(yesterday),
    preset:    "thisMonth",
  };
}

export function getLastMonthRange(): ConsumptionDateRange {
  const now  = new Date();
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const mon  = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
  const last = lastDayOfMonth(year, mon);
  return {
    startDate: `${year}-${String(mon + 1).padStart(2, "0")}-01`,
    endDate:   `${year}-${String(mon + 1).padStart(2, "0")}-${String(last).padStart(2, "0")}`,
    preset:    "lastMonth",
  };
}

/** Returns 3 separate [startDate, endDate] pairs covering the last 3 calendar months. */
export function getLast3MonthRanges(): { startDate: string; endDate: string }[] {
  const now    = new Date();
  const ranges: { startDate: string; endDate: string }[] = [];
  for (let offset = 2; offset >= 0; offset--) {
    const d    = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const year = d.getFullYear();
    const mon  = d.getMonth();
    const isCurrentMonth = offset === 0;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const endDay = isCurrentMonth ? yesterday.getDate() : lastDayOfMonth(year, mon);
    ranges.push({
      startDate: `${year}-${String(mon + 1).padStart(2, "0")}-01`,
      endDate:   `${year}-${String(mon + 1).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`,
    });
  }
  return ranges;
}

// ─── ConsumptionRangePicker ───────────────────────────────────────────────────

export function ConsumptionRangePicker({
  value,
  onChange,
}: ConsumptionRangePickerProps) {
  const [customMode, setCustomMode] = useState(value.preset === "custom");
  const [customStart, setCustomStart] = useState(value.startDate);
  const [customEnd, setCustomEnd] = useState(value.endDate);
  const [error, setError] = useState<string | null>(null);

  const today = toYYYYMMDD(new Date());

  function handlePreset(preset: ConsumptionPreset) {
    setCustomMode(false);
    setError(null);
    if (preset === "thisMonth") {
      onChange(getThisMonthRange());
    } else if (preset === "lastMonth") {
      onChange(getLastMonthRange());
    } else if (preset === "last3Months") {
      const ranges = getLast3MonthRanges();
      onChange({
        startDate: ranges[0].startDate,
        endDate:   ranges[ranges.length - 1].endDate,
        preset:    "last3Months",
      });
    } else {
      setCustomMode(true);
    }
  }

  function handleCustomApply() {
    setError(null);
    if (!customStart || !customEnd) {
      setError("Please enter both start and end dates.");
      return;
    }
    if (customEnd < customStart) {
      setError("End date must be after start date.");
      return;
    }
    const msPerDay = 24 * 60 * 60 * 1000;
    const dayDiff = Math.round(
      (new Date(customEnd).getTime() - new Date(customStart).getTime()) / msPerDay
    );
    if (dayDiff > 31) {
      setError("Maximum range is 31 days.");
      return;
    }
    onChange({ startDate: customStart, endDate: customEnd, preset: "custom" });
  }

  // Capsule button style — 1px border, active: accent color + background + text
  function presetStyle(isActive: boolean): React.CSSProperties {
    return {
      color: isActive ? "var(--accent-primary)" : "var(--text-tertiary)",
      fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
      fontSize: "12px",
      fontWeight: isActive ? 500 : 400,
      border: "1px solid",
      borderColor: isActive ? "var(--accent-primary)" : "var(--border-subtle)",
      background: isActive ? "rgba(217, 165, 80, 0.12)" : "transparent",
      padding: "8px 14px",
      minHeight: "36px",
      borderRadius: "999px",
      transition: "color 0.15s, border-color 0.15s, background 0.15s",
      letterSpacing: "0.02em",
      display: "inline-flex",
      alignItems: "center",
    };
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        style={presetStyle(value.preset === "thisMonth" && !customMode)}
        onClick={() => handlePreset("thisMonth")}
      >
        This month
      </button>
      <button
        style={presetStyle(value.preset === "lastMonth" && !customMode)}
        onClick={() => handlePreset("lastMonth")}
      >
        Last month
      </button>
      <button
        style={presetStyle(value.preset === "last3Months" && !customMode)}
        onClick={() => handlePreset("last3Months")}
      >
        Last 3 months
      </button>
      <button
        style={presetStyle(customMode)}
        onClick={() => handlePreset("custom")}
      >
        Custom
      </button>

      {customMode && (
        <div className="flex flex-wrap items-center gap-3 mt-2 w-full">
          <div className="flex items-center gap-1.5 w-full sm:w-auto">
            <label className="font-sans text-xs shrink-0" style={{ color: "var(--text-tertiary)" }}>From</label>
            <input
              type="date"
              value={customStart}
              max={today}
              onChange={(e) => setCustomStart(e.target.value)}
              className="font-mono text-xs px-2 py-1 rounded focus:outline-none flex-1 sm:flex-none"
              style={{
                background: "var(--bg-input)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-medium)",
              }}
            />
          </div>
          <div className="flex items-center gap-1.5 w-full sm:w-auto">
            <label className="font-sans text-xs shrink-0" style={{ color: "var(--text-tertiary)" }}>To</label>
            <input
              type="date"
              value={customEnd}
              max={today}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="font-mono text-xs px-2 py-1 rounded focus:outline-none flex-1 sm:flex-none"
              style={{
                background: "var(--bg-input)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-medium)",
              }}
            />
          </div>
          <button
            onClick={handleCustomApply}
            className="font-sans text-xs font-medium px-4 rounded-full transition-colors"
            style={{
              background: "var(--accent-primary)",
              color: "var(--bg-deep)",
              minHeight: "36px",
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            Apply
          </button>
          {error && (
            <p className="font-sans text-xs w-full" style={{ color: "var(--color-holiday)" }}>{error}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Legacy MonthRangePicker (kept for TopupRangePicker compatibility) ────────

function toYYYYMM(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthDiff(start: string, end: string): number {
  const [sy, sm] = start.split("-").map(Number);
  const [ey, em] = end.split("-").map(Number);
  return (ey - sy) * 12 + (em - sm);
}

function monthOptions(): { value: string; label: string }[] {
  const now = new Date();
  const current = toYYYYMM(now);
  const result: { value: string; label: string }[] = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const value = toYYYYMM(d);
    const label = d.toLocaleDateString("en-BN", { month: "short", year: "numeric" });
    result.push({ value, label });
  }
  if (!result.find((r) => r.value === current)) {
    result.push({
      value: current,
      label: now.toLocaleDateString("en-BN", { month: "short", year: "numeric" }),
    });
  }
  return result;
}

const MONTH_OPTIONS = monthOptions();

interface MonthRangePickerProps {
  value: MonthRange;
  onChange: (range: MonthRange) => void;
}

export function MonthRangePicker({ value, onChange }: MonthRangePickerProps) {
  const [customMode, setCustomMode] = useState(false);
  const [customStart, setCustomStart] = useState(value.startMonth);
  const [customEnd, setCustomEnd] = useState(value.endMonth);
  const [error, setError] = useState<string | null>(null);

  const now = new Date();
  const currentMonth = toYYYYMM(now);

  function applyPreset(months: number) {
    const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
    const range: MonthRange = { startMonth: toYYYYMM(start), endMonth: currentMonth };
    setCustomMode(false);
    setError(null);
    onChange(range);
  }

  function handleCustomApply() {
    setError(null);
    if (!customStart || !customEnd) { setError("Please select both start and end months."); return; }
    if (customEnd < customStart)    { setError("End month must be after start month."); return; }
    if (monthDiff(customStart, customEnd) > 5) { setError("Maximum range is 6 months."); return; }
    onChange({ startMonth: customStart, endMonth: customEnd });
  }

  const isPreset3 = monthDiff(value.startMonth, value.endMonth) === 2 && value.endMonth === currentMonth;
  const isPreset6 = monthDiff(value.startMonth, value.endMonth) === 5 && value.endMonth === currentMonth;

  function btnStyle(isActive: boolean): React.CSSProperties {
    return {
      color: isActive ? "var(--accent-primary)" : "var(--text-tertiary)",
      fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
      fontSize: "11px",
      fontWeight: isActive ? 500 : 400,
      border: "1px solid",
      borderColor: isActive ? "var(--accent-primary)" : "var(--border-subtle)",
      padding: "3px 10px",
      borderRadius: "999px",
      transition: "color 0.15s, border-color 0.15s",
    };
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button style={btnStyle(isPreset3 && !customMode)} onClick={() => applyPreset(3)}>Last 3 months</button>
      <button style={btnStyle(isPreset6 && !customMode)} onClick={() => applyPreset(6)}>Last 6 months</button>
      <button style={btnStyle(customMode)} onClick={() => { setCustomMode(true); setCustomStart(value.startMonth); setCustomEnd(value.endMonth); }}>Custom</button>
      {customMode && (
        <div className="flex flex-wrap items-center gap-3 w-full mt-1">
          <div className="flex items-center gap-1.5">
            <label className="font-sans text-xs" style={{ color: "var(--text-tertiary)" }}>From</label>
            <select
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              className="font-sans text-xs px-2 py-1 rounded focus:outline-none"
              style={{ background: "var(--bg-input)", color: "var(--text-primary)", border: "1px solid var(--border-medium)" }}
            >
              {MONTH_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <label className="font-sans text-xs" style={{ color: "var(--text-tertiary)" }}>To</label>
            <select
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="font-sans text-xs px-2 py-1 rounded focus:outline-none"
              style={{ background: "var(--bg-input)", color: "var(--text-primary)", border: "1px solid var(--border-medium)" }}
            >
              {MONTH_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <button
            onClick={handleCustomApply}
            className="font-sans text-xs font-medium px-4 py-1 rounded-full"
            style={{ background: "var(--accent-primary)", color: "var(--bg-deep)" }}
          >
            Apply
          </button>
          {error && <p className="font-sans text-xs w-full" style={{ color: "var(--color-holiday)" }}>{error}</p>}
        </div>
      )}
    </div>
  );
}

// ─── TopupRangePicker ─────────────────────────────────────────────────────────

export function TopupRangePicker({ value, onChange }: TopupRangePickerProps) {
  const [customMode, setCustomMode] = useState(false);
  const [customStart, setCustomStart] = useState(value.startDate);
  const [customEnd, setCustomEnd] = useState(value.endDate);
  const [error, setError] = useState<string | null>(null);

  const today = new Date();
  const todayStr = toYYYYMMDD(today);

  function applyPreset(days: number) {
    const start = new Date(today);
    start.setDate(today.getDate() - days + 1);
    const range: DateRange = { startDate: toYYYYMMDD(start), endDate: todayStr };
    setCustomMode(false);
    setError(null);
    onChange(range);
  }

  function handleCustomApply() {
    setError(null);
    if (!customStart || !customEnd) {
      setError("Please enter both start and end dates.");
      return;
    }
    if (customEnd < customStart) {
      setError("End date must be after start date.");
      return;
    }
    onChange({ startDate: customStart, endDate: customEnd });
  }

  function isPreset(days: number): boolean {
    const start = new Date(today);
    start.setDate(today.getDate() - days + 1);
    return value.startDate === toYYYYMMDD(start) && value.endDate === todayStr;
  }

  function btnStyle(isActive: boolean): React.CSSProperties {
    return {
      color: isActive ? "var(--accent-primary)" : "var(--text-tertiary)",
      fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
      fontSize: "11px",
      fontWeight: isActive ? 500 : 400,
      border: "1px solid",
      borderColor: isActive ? "var(--accent-primary)" : "var(--border-subtle)",
      padding: "3px 10px",
      borderRadius: "999px",
      transition: "color 0.15s, border-color 0.15s",
    };
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {([30, 90] as const).map((d) => (
        <button
          key={d}
          style={btnStyle(isPreset(d) && !customMode)}
          onClick={() => applyPreset(d)}
        >
          Last {d} days
        </button>
      ))}
      <button
        style={btnStyle(isPreset(180) && !customMode)}
        onClick={() => applyPreset(180)}
      >
        Last 6 months
      </button>
      <button
        style={btnStyle(customMode)}
        onClick={() => {
          setCustomMode(true);
          setCustomStart(value.startDate);
          setCustomEnd(value.endDate);
        }}
      >
        Custom
      </button>

      {customMode && (
        <div className="flex flex-wrap items-center gap-3 w-full mt-1">
          <div className="flex items-center gap-1.5">
            <label className="font-sans text-xs" style={{ color: "var(--text-tertiary)" }}>From</label>
            <input
              type="date"
              value={customStart}
              max={todayStr}
              onChange={(e) => setCustomStart(e.target.value)}
              className="font-mono text-xs px-2 py-1 rounded focus:outline-none"
              style={{ background: "var(--bg-input)", color: "var(--text-primary)", border: "1px solid var(--border-medium)" }}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <label className="font-sans text-xs" style={{ color: "var(--text-tertiary)" }}>To</label>
            <input
              type="date"
              value={customEnd}
              max={todayStr}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="font-mono text-xs px-2 py-1 rounded focus:outline-none"
              style={{ background: "var(--bg-input)", color: "var(--text-primary)", border: "1px solid var(--border-medium)" }}
            />
          </div>
          <button
            onClick={handleCustomApply}
            className="font-sans text-xs font-medium px-4 py-1 rounded-full"
            style={{ background: "var(--accent-primary)", color: "var(--bg-deep)" }}
          >
            Apply
          </button>
          {error && (
            <p className="font-sans text-xs w-full" style={{ color: "var(--color-holiday)" }}>{error}</p>
          )}
        </div>
      )}
    </div>
  );
}
