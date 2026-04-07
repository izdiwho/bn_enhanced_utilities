/**
 * UsagePatterns — day-of-week consumption breakdown.
 *
 * Kampong Grid styling:
 * - Horizontal bars: 8px height, border-radius 1px (industrial)
 * - Day labels: font-mono 10px
 * - Values right-aligned: font-mono 10px
 * - Weekend vs weekday summary in font-sans
 */
import type { ConsumptionRecord } from "../types/usms.js";

interface UsagePatternsProps {
  records: ConsumptionRecord[];
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// JS getDay(): 0=Sun, 1=Mon, ..., 6=Sat → map to Mon-first index
const JS_TO_MON_FIRST: Record<number, number> = {
  1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 0: 6,
};

const WEEKEND_DAYS = new Set([5, 6]); // Sat=5, Sun=6 in Mon-first indexing

export function UsagePatterns({ records }: UsagePatternsProps) {
  if (records.length === 0) {
    return (
      <div>
        <SectionHeader>Usage Patterns</SectionHeader>
        <p className="font-sans text-sm" style={{ color: "var(--text-tertiary)" }}>No data to analyse.</p>
      </div>
    );
  }

  // Bucket totals and counts by day-of-week (Mon-first, 0–6)
  const totals = new Array(7).fill(0) as number[];
  const counts = new Array(7).fill(0) as number[];

  for (const record of records) {
    const dayJs = new Date(record.period + "T00:00:00").getDay();
    const dow = JS_TO_MON_FIRST[dayJs];
    totals[dow] += record.consumption;
    counts[dow]++;
  }

  const averages = totals.map((t, i) => (counts[i] > 0 ? t / counts[i] : 0));
  const maxAvg = Math.max(...averages, 0.001);

  // Weekend vs weekday averages
  let weekendTotal = 0, weekendCount = 0;
  let weekdayTotal = 0, weekdayCount = 0;

  for (let d = 0; d < 7; d++) {
    if (counts[d] === 0) continue;
    if (WEEKEND_DAYS.has(d)) {
      weekendTotal += totals[d];
      weekendCount += counts[d];
    } else {
      weekdayTotal += totals[d];
      weekdayCount += counts[d];
    }
  }

  const weekendAvg = weekendCount > 0 ? weekendTotal / weekendCount : 0;
  const weekdayAvg = weekdayCount > 0 ? weekdayTotal / weekdayCount : 0;

  let comparisonText = "";
  if (weekdayAvg > 0 && weekendAvg > 0) {
    const pct = ((weekendAvg - weekdayAvg) / weekdayAvg) * 100;
    const absPct = Math.abs(pct).toFixed(0);
    if (pct > 2) {
      comparisonText = `${absPct}% higher on weekends`;
    } else if (pct < -2) {
      comparisonText = `${absPct}% lower on weekends`;
    } else {
      comparisonText = "similar on weekdays and weekends";
    }
  }

  return (
    <div>
      <SectionHeader>Usage Patterns</SectionHeader>

      {/* Day-of-week bars */}
      <div className="space-y-2 mb-4">
        {DAY_NAMES.map((name, d) => {
          const avg = averages[d];
          const pct = avg > 0 ? (avg / maxAvg) * 100 : 0;
          const isWeekend = WEEKEND_DAYS.has(d);
          const barColor = isWeekend ? "var(--color-weekend)" : "var(--accent-primary)";
          return (
            <div key={name} className="flex items-center gap-3">
              <span
                className="font-mono shrink-0"
                style={{
                  color: isWeekend ? "var(--color-weekend)" : "var(--text-secondary)",
                  fontSize: "11px",
                  width: "28px",
                }}
              >
                {name}
              </span>
              <div
                className="flex-1 overflow-hidden"
                style={{ height: "8px", background: "var(--bg-raised)", borderRadius: "1px" }}
              >
                {pct > 0 && (
                  <div
                    className="h-full transition-all"
                    style={{ width: `${pct}%`, background: barColor, opacity: 0.8, borderRadius: "1px" }}
                  />
                )}
              </div>
              <span
                className="font-mono shrink-0 text-right"
                style={{ color: "var(--text-secondary)", fontSize: "11px", width: "52px" }}
              >
                {counts[d] > 0 ? avg.toFixed(2) : "—"}
              </span>
            </div>
          );
        })}
      </div>

      {/* Summary line */}
      <p className="font-sans text-xs" style={{ color: "var(--text-tertiary)" }}>
        Weekday avg:{" "}
        <span className="font-mono" style={{ color: "var(--text-secondary)" }}>{weekdayAvg.toFixed(2)}</span>
        {" · "}
        Weekend avg:{" "}
        <span className="font-mono" style={{ color: "var(--color-weekend)", opacity: 0.85 }}>{weekendAvg.toFixed(2)}</span>
        {comparisonText && (
          <span> · {comparisonText}</span>
        )}
      </p>
    </div>
  );
}

// ─── Shared sub-components ────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="font-sans font-medium uppercase mb-3"
      style={{
        color: "var(--text-tertiary)",
        fontSize: "11px",
        letterSpacing: "0.12em",
      }}
    >
      {children}
    </p>
  );
}
