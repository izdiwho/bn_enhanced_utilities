/**
 * ChartToggles — text-style overlay toggles for the daily ConsumptionChart.
 *
 * Buttons:
 *  - Clean      (reset)  — removes all overlays
 *  - Weekends   (purple) — shade Saturday/Sunday bars
 *  - Holidays   (red)    — color public holiday bars
 *  - School     (green)  — color school holiday bars
 *  - Weather    (teal)   — overlay feels-like temperature lines on right Y axis
 *  - AI Baseline (ochre) — dashed horizontal line at estimated daily kWh
 *
 * Each active toggle shows a small 8×4px filled rectangle prefix.
 * Inactive toggles show an outlined rectangle.
 * "Clean" is always first, acts as reset.
 */
import { isPublicHoliday } from "../data/brunei-calendar.js";

export interface ChartOverlayState {
  showWeekends:    boolean;
  showHolidays:    boolean;
  showSchool:      boolean;
  showWeather:     boolean;
  showAiBaseline:  boolean;
  // Legacy fields kept for backward-compatibility with BalanceForecast / SummaryStats
  showHolidayHighlight: boolean;
  showHolidayCount:     boolean;
  showCostOverlay:      boolean;
}

export function defaultOverlayState(): ChartOverlayState {
  return {
    showWeekends:         false,
    showHolidays:         false,
    showSchool:           false,
    showWeather:          false,
    showAiBaseline:       false,
    showHolidayHighlight: false,
    showHolidayCount:     false,
    showCostOverlay:      false,
  };
}

interface ChartTogglesProps {
  state: ChartOverlayState;
  onToggle: (key: keyof ChartOverlayState) => void;
  onCleanView: () => void;
  aiBaselineAvailable?: boolean;
  /** Whether AI features are enabled at all (OPENROUTER_API_KEY present). */
  aiEnabled?: boolean;
}

interface ToggleItemProps {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  rectColor?: string;
  children: React.ReactNode;
}

function ToggleItem({ active, onClick, disabled = false, rectColor, children }: ToggleItemProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1.5 font-sans uppercase transition-colors"
      style={{
        color: disabled
          ? "var(--text-tertiary)"
          : active
            ? (rectColor ?? "var(--text-primary)")
            : "var(--text-tertiary)",
        opacity: disabled ? 0.35 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        fontWeight: active ? 500 : 400,
        fontSize: "12px",
        letterSpacing: "0.08em",
      }}
    >
      {/* 10×5px rectangle indicator — filled when active, outlined when inactive */}
      <span
        style={{
          display: "inline-block",
          width: "10px",
          height: "5px",
          flexShrink: 0,
          borderRadius: "2px",
          background: active && rectColor ? rectColor : "transparent",
          border: `1px solid ${active && rectColor ? rectColor : "var(--text-tertiary)"}`,
          opacity: disabled ? 0.5 : 1,
        }}
      />
      {children}
    </button>
  );
}

export function ChartToggles({
  state,
  onToggle,
  onCleanView,
  aiBaselineAvailable = false,
  aiEnabled = true,
}: ChartTogglesProps) {
  const anyActive =
    state.showWeekends ||
    state.showHolidays ||
    state.showSchool   ||
    state.showWeather  ||
    state.showAiBaseline;

  return (
    <div className="flex flex-wrap gap-4 items-center">
      <ToggleItem
        active={!anyActive}
        onClick={onCleanView}
        rectColor="var(--text-secondary)"
      >
        Clean
      </ToggleItem>

      <ToggleItem
        active={state.showWeekends}
        onClick={() => onToggle("showWeekends")}
        rectColor="var(--color-weekend)"
      >
        Weekends
      </ToggleItem>

      <ToggleItem
        active={state.showHolidays}
        onClick={() => onToggle("showHolidays")}
        rectColor="var(--color-holiday)"
      >
        Holidays
      </ToggleItem>

      <ToggleItem
        active={state.showSchool}
        onClick={() => onToggle("showSchool")}
        rectColor="var(--color-school)"
      >
        School
      </ToggleItem>

      <ToggleItem
        active={state.showWeather}
        onClick={() => onToggle("showWeather")}
        rectColor="var(--color-water)"
      >
        Weather
      </ToggleItem>

      {aiEnabled && (
        <ToggleItem
          active={state.showAiBaseline}
          onClick={() => onToggle("showAiBaseline")}
          disabled={!aiBaselineAvailable}
          rectColor="var(--accent-primary)"
        >
          AI Baseline
        </ToggleItem>
      )}
    </div>
  );
}

// ─── Holiday helpers exported for ConsumptionChart ────────────────────────────

/**
 * Count public holidays in a given YYYY-MM month.
 */
export function countHolidaysInMonth(yyyyMM: string): number {
  const [y, m] = yyyyMM.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${yyyyMM}-${String(d).padStart(2, "0")}`;
    if (isPublicHoliday(iso)) count++;
  }
  return count;
}

/**
 * Given an array of YYYY-MM strings, return a parallel array of holiday counts,
 * plus the average count across all months.
 */
export function getMonthlyHolidayCounts(periods: string[]): {
  counts: number[];
  avg: number;
} {
  const counts = periods.map(countHolidaysInMonth);
  const avg = counts.length > 0 ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
  return { counts, avg };
}
