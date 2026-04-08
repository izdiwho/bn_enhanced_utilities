/**
 * ForecastChart — 7-day consumption forecast rendered as a bar chart.
 *
 * Uses Chart.js (already registered by ConsumptionChart on the same page).
 * Two datasets:
 *   1. "Forecast" bars — translucent accent color (lighter than actual bars)
 *   2. A shaded confidence band drawn as floating bars (lower→upper range)
 *      using a second dataset with barThickness matched to the first.
 *
 * Fetches from GET /api/analytics/forecast?meterNo=X on mount.
 * Section header is rendered outside this component in Dashboard.tsx.
 */
import { useState, useEffect } from "react";
import {
  Chart as ChartJS,
  BarController,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
  type ChartData,
  type ChartOptions,
} from "chart.js";
import { Bar } from "react-chartjs-2";
import { getForecast, type Forecast } from "../api/usms.js";

ChartJS.register(
  BarController,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend
);

// IBM Plex Mono for all chart text (matches ConsumptionChart)
const MONO_FONT  = "'IBM Plex Mono', monospace";
const TICK_COLOR = "rgba(125,120,112,1)";
const GRID_COLOR = "rgba(255,255,255,0.08)";

// Forecast bar: translucent blue-cyan accent
const FORECAST_BG     = "rgba(56,189,248,0.45)";
const FORECAST_BORDER = "rgba(56,189,248,0.75)";
// Confidence band: very light fill
const CONFIDENCE_BG   = "rgba(56,189,248,0.12)";

/** Format a YYYY-MM-DD date as "Mon 7 Apr" */
function formatForecastDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

interface ForecastChartProps {
  meterNo: string;
  unitLabel: string;
}

export function ForecastChart({ meterNo, unitLabel }: ForecastChartProps) {
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getForecast(meterNo)
      .then((data) => {
        if (!cancelled) { setForecast(data); setLoading(false); }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load forecast");
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [meterNo]);

  const isMobile = typeof window !== "undefined" && window.innerWidth < 640;
  const chartHeight = isMobile ? "220px" : "280px";

  if (loading) {
    return (
      <div
        className="flex items-center justify-center animate-pulse"
        style={{ height: chartHeight, color: "var(--text-tertiary)" }}
      >
        <span className="font-mono text-xs">Computing forecast...</span>
      </div>
    );
  }

  if (error) {
    return (
      <p className="font-sans text-sm" style={{ color: "var(--text-tertiary)" }}>
        Forecast unavailable — {error}
      </p>
    );
  }

  if (!forecast || forecast.days.length === 0 || forecast.basedOnDays === 0) {
    return (
      <p className="font-sans text-sm" style={{ color: "var(--text-tertiary)" }}>
        Not enough historical data for a forecast yet. Data will accumulate automatically.
      </p>
    );
  }

  const labels   = forecast.days.map((d) => formatForecastDay(d.date));
  const predicted = forecast.days.map((d) => d.predicted);
  // Confidence band as floating bars: [lower, upper]
  const confBands = forecast.days.map((d) => [d.lower, d.upper]);

  const chartData: ChartData<"bar"> = {
    labels,
    datasets: [
      {
        label: "Confidence range",
        data: confBands as unknown as number[],
        backgroundColor: CONFIDENCE_BG,
        borderColor: "transparent",
        borderWidth: 0,
        borderRadius: 2,
        order: 2,
      },
      {
        label: `Forecast (${unitLabel})`,
        data: predicted,
        backgroundColor: FORECAST_BG,
        borderColor: FORECAST_BORDER,
        borderWidth: 1,
        borderRadius: 3,
        order: 1,
      },
    ],
  };

  const options: ChartOptions<"bar"> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: true,
        position: "top",
        labels: {
          color: TICK_COLOR,
          font: { family: MONO_FONT, size: 10 },
          boxWidth: 10,
          padding: 12,
        },
      },
      tooltip: {
        backgroundColor: "rgba(30,28,24,0.95)",
        titleColor: TICK_COLOR,
        bodyColor: "#d4cdc4",
        titleFont: { family: MONO_FONT, size: 11 },
        bodyFont:  { family: MONO_FONT, size: 11 },
        callbacks: {
          label: (ctx) => {
            const raw = ctx.raw;
            if (Array.isArray(raw)) {
              return `Confidence: ${(raw[0] as number).toFixed(2)}–${(raw[1] as number).toFixed(2)} ${unitLabel}`;
            }
            return `${ctx.dataset.label}: ${(ctx.parsed.y as number).toFixed(2)} ${unitLabel}`;
          },
        },
      },
    },
    scales: {
      x: {
        ticks: {
          color: TICK_COLOR,
          font: { family: MONO_FONT, size: 10 },
          maxRotation: 45,
        },
        grid: { color: GRID_COLOR },
        border: { color: GRID_COLOR },
      },
      y: {
        beginAtZero: true,
        ticks: {
          color: TICK_COLOR,
          font: { family: MONO_FONT, size: 10 },
          callback: (v) => `${v}`,
        },
        grid: { color: GRID_COLOR },
        border: { color: GRID_COLOR },
        title: {
          display: true,
          text: unitLabel,
          color: TICK_COLOR,
          font: { family: MONO_FONT, size: 10 },
        },
      },
    },
  };

  return (
    <div>
      <div style={{ height: chartHeight }}>
        <Bar data={chartData} options={options} />
      </div>
      <p
        className="font-mono mt-3"
        style={{ fontSize: "11px", color: "var(--text-tertiary)" }}
      >
        Based on last {forecast.basedOnDays} days · EMA with day-of-week adjustment
      </p>
    </div>
  );
}
