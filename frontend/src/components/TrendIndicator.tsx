/**
 * TrendIndicator — inline "↑ 12% vs last month" or "↓ 8%" or "→ stable".
 *
 * Color convention (from the user's perspective):
 *   down  → green  (spending less = good)
 *   up    → red    (spending more = bad)
 *   stable → tertiary text (neutral)
 *
 * Compact and inline — placed in the Overview section near the balance display.
 * Fetches from GET /api/analytics/trend?meterNo=X&period=30d on mount.
 */
import { useState, useEffect } from "react";
import { getTrend, type TrendAnalysis } from "../api/usms.js";

interface TrendIndicatorProps {
  meterNo: string;
  period?: TrendAnalysis["period"];
}

const ARROW = {
  up:     "↑",
  down:   "↓",
  stable: "→",
};

const COLOR = {
  up:     "var(--color-holiday)",   // red
  down:   "var(--color-school)",    // green
  stable: "var(--text-tertiary)",
};

export function TrendIndicator({ meterNo, period = "30d" }: TrendIndicatorProps) {
  const [trend, setTrend] = useState<TrendAnalysis | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getTrend(meterNo, period)
      .then((data) => { if (!cancelled) { setTrend(data); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [meterNo, period]);

  if (loading) {
    return (
      <span
        className="font-mono animate-pulse"
        style={{ fontSize: "12px", color: "var(--text-tertiary)" }}
      >
        …
      </span>
    );
  }

  if (!trend || trend.currentAvgDaily === 0) return null;

  const color  = COLOR[trend.direction];
  const arrow  = ARROW[trend.direction];
  const absChg = Math.abs(trend.changePercent);

  const label =
    trend.direction === "stable"
      ? "stable"
      : `${absChg.toFixed(1)}%`;

  const periodLabel =
    period === "7d"  ? "last week" :
    period === "30d" ? "last month" : "last 3 months";

  return (
    <span
      title={trend.insight}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        fontSize: "12px",
        color,
      }}
    >
      <span>{arrow}</span>
      <span className="font-mono" style={{ fontWeight: 500 }}>{label}</span>
      <span
        style={{ color: "var(--text-tertiary)", fontSize: "11px" }}
      >
        vs {periodLabel}
      </span>
    </span>
  );
}
