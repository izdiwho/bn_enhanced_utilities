/**
 * Daily consumption bar chart — Kampong Grid styling.
 *
 * Bars are colored by day type when overlays are active:
 *  - Normal weekday  → blue-ish  rgba(70,130,210,0.65)
 *  - Weekend         → var(--color-weekend) at 0.65 opacity
 *  - Public holiday  → var(--color-holiday) at 0.70 opacity
 *  - School holiday  → var(--color-school)  at 0.65 opacity
 *  Day-type priority (highest first): holiday > school > weekend > normal.
 *
 * Weather overlay: Feels Like High (red line) + Feels Like Low (teal dashed)
 * on the secondary Y axis (°C), shown when showWeather is active.
 *
 * AI Baseline: dashed horizontal line at the provided dailyBaselineKwh value.
 *
 * Uses Chart.js 4 + react-chartjs-2.
 */
import {
  Chart as ChartJS,
  BarController,
  LineController,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  Title,
  Tooltip,
  Legend,
  type ChartData,
  type ChartOptions,
} from "chart.js";
import { Chart } from "react-chartjs-2";
import type { ConsumptionRecord, WeatherData } from "../types/usms.js";
import { calculateCost, ELECTRICITY_TARIFF, WATER_TARIFF } from "../utils/tariff.js";
import type { ChartOverlayState } from "./ChartToggles.js";
import { getDayType } from "../data/brunei-calendar.js";

ChartJS.register(
  BarController,
  LineController,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  Title,
  Tooltip,
  Legend
);

// ─── Day-type colors ──────────────────────────────────────────────────────────

const BAR_COLORS = {
  normal:  { bg: "rgba(80,145,220,0.7)",   border: "rgba(80,145,220,0.9)"  },
  weekend: { bg: "rgba(112,96,184,0.65)",  border: "rgba(112,96,184,0.9)"  },
  holiday: { bg: "rgba(184,80,80,0.70)",   border: "rgba(184,80,80,0.9)"   },
  school:  { bg: "rgba(80,138,104,0.65)",  border: "rgba(80,138,104,0.9)"  },
};

// IBM Plex Mono for all chart text
const MONO_FONT = "'IBM Plex Mono', monospace";
// Axis tick color — brighter for legibility
const TICK_COLOR = "rgba(125,120,112,1)";
// Grid line color — visible enough to trace values
const GRID_COLOR = "rgba(255,255,255,0.08)";

// ─── Component ────────────────────────────────────────────────────────────────

interface ConsumptionChartProps {
  records: ConsumptionRecord[];
  unitLabel: string;
  meterType?: "electricity" | "water";
  warning?: string;
  loading: boolean;
  overlays?: ChartOverlayState;
  weatherData?: WeatherData | null;
  dailyBaselineKwh?: number | null;
  dailyBaselineMin?: number | null;
  dailyBaselineMax?: number | null;
}

/** Format a YYYY-MM-DD date as "1 Mar" for the x-axis label */
function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

export function ConsumptionChart({
  records,
  unitLabel,
  meterType = "electricity",
  warning,
  loading,
  overlays,
  weatherData,
  dailyBaselineKwh,
  dailyBaselineMin,
  dailyBaselineMax,
}: ConsumptionChartProps) {
  const isMobileEarly = typeof window !== "undefined" && window.innerWidth < 640;
  const chartHeight = isMobileEarly ? "280px" : "380px";

  if (loading) {
    return (
      <div className="flex items-center justify-center" style={{ height: chartHeight, color: "var(--text-tertiary)" }}>
        <span className="font-mono text-xs">Loading chart...</span>
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2" style={{ height: chartHeight }}>
        <p className="font-sans text-sm" style={{ color: "var(--text-tertiary)" }}>No consumption data available.</p>
      </div>
    );
  }

  const tariff = meterType === "electricity" ? ELECTRICITY_TARIFF : WATER_TARIFF;
  const labels = records.map((r) => formatDay(r.period));
  const values = records.map((r) => r.consumption);

  // Bar colors by day type
  const bgColors: string[] = [];
  const borderColors: string[] = [];

  for (const r of records) {
    const dayType = getDayType(r.period);
    let effectiveType: keyof typeof BAR_COLORS = "normal";

    if (overlays?.showHolidays && dayType === "holiday") {
      effectiveType = "holiday";
    } else if (overlays?.showSchool && dayType === "school") {
      effectiveType = "school";
    } else if (overlays?.showWeekends && dayType === "weekend") {
      effectiveType = "weekend";
    }

    bgColors.push(BAR_COLORS[effectiveType].bg);
    borderColors.push(BAR_COLORS[effectiveType].border);
  }

  const datasets: unknown[] = [
    {
      type:            "bar" as const,
      label:           `Consumption (${unitLabel})`,
      data:            values,
      backgroundColor: bgColors,
      borderColor:     borderColors,
      borderWidth:     0,
      borderRadius:    2,
      yAxisID:         "y",
    },
  ];

  // Weather overlay
  const showWeather = overlays?.showWeather && weatherData && weatherData.dates.length > 0;
  if (showWeather && weatherData) {
    // Align weather data to chart labels by date
    const dateToHighMap = new Map(
      weatherData.dates.map((d, i) => [d, weatherData.feelsLikeHigh[i]])
    );
    const dateToLowMap = new Map(
      weatherData.dates.map((d, i) => [d, weatherData.feelsLikeLow[i]])
    );

    const highValues = records.map((r) => dateToHighMap.get(r.period) ?? null);
    const lowValues  = records.map((r) => dateToLowMap.get(r.period) ?? null);

    datasets.push({
      type:            "line" as const,
      label:           "Feels Like High (°C)",
      data:            highValues,
      borderColor:     "rgba(184,80,80,0.85)",
      backgroundColor: "transparent",
      borderWidth:     1.5,
      pointRadius:     1.5,
      pointBackgroundColor: "rgba(184,80,80,0.85)",
      tension:         0.3,
      yAxisID:         "y2",
      spanGaps:        true,
    });

    datasets.push({
      type:            "line" as const,
      label:           "Feels Like Low (°C)",
      data:            lowValues,
      borderColor:     "rgba(58,143,154,0.85)",
      backgroundColor: "transparent",
      borderWidth:     1.5,
      borderDash:      [4, 4],
      pointRadius:     1.5,
      pointBackgroundColor: "rgba(58,143,154,0.85)",
      tension:         0.3,
      yAxisID:         "y2",
      spanGaps:        true,
    });
  }

  // AI Baseline min/max range lines
  if (overlays?.showAiBaseline && dailyBaselineKwh != null && dailyBaselineKwh > 0) {
    const bMin = dailyBaselineMin ?? dailyBaselineKwh;
    const bMax = dailyBaselineMax ?? dailyBaselineKwh;
    if (bMin !== bMax) {
      datasets.push({
        type:            "line" as const,
        label:           `AI Min (${bMin.toFixed(1)} ${unitLabel}/day)`,
        data:            records.map(() => bMin),
        borderColor:     "rgba(204,149,68,0.45)",
        backgroundColor: "transparent",
        borderWidth:     1,
        borderDash:      [4, 4],
        pointRadius:     0,
        tension:         0,
        yAxisID:         "y",
      });
      datasets.push({
        type:            "line" as const,
        label:           `AI Max (${bMax.toFixed(1)} ${unitLabel}/day)`,
        data:            records.map(() => bMax),
        borderColor:     "rgba(204,149,68,0.45)",
        backgroundColor: "transparent",
        borderWidth:     1,
        borderDash:      [4, 4],
        pointRadius:     0,
        tension:         0,
        yAxisID:         "y",
      });
    }
    // Always show the midpoint line
    datasets.push({
      type:            "line" as const,
      label:           `AI Baseline (${dailyBaselineKwh.toFixed(1)} ${unitLabel}/day)`,
      data:            records.map(() => dailyBaselineKwh),
      borderColor:     "rgba(204,149,68,0.7)",
      backgroundColor: "transparent",
      borderWidth:     1.5,
      borderDash:      [6, 3],
      pointRadius:     0,
      tension:         0,
      yAxisID:         "y",
    });
  }

  const data: ChartData<"bar"> = {
    labels,
    datasets: datasets as ChartData<"bar">["datasets"],
  };

  const hasLegend = showWeather || (overlays?.showAiBaseline && dailyBaselineKwh != null);

  // Auto-skip x-axis labels when many bars — skip more aggressively on narrow screens
  const isMobile = isMobileEarly;
  const skipModulo = records.length > 15 && isMobile
    ? 5
    : records.length > 20
    ? 3
    : records.length > 10
    ? 2
    : 1;

  const options: ChartOptions<"bar"> = {
    responsive: true,
    maintainAspectRatio: true,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: {
        display: !!hasLegend,
        labels: {
          boxWidth: 10,
          font: { size: 10, family: MONO_FONT },
          color: TICK_COLOR,
          filter: (item) => item.text !== `Consumption (${unitLabel})`,
        },
      },
      title: { display: false },
      tooltip: {
        backgroundColor: "#181c24",
        titleColor: "#ddd9d3",
        bodyColor: "#7d7870",
        borderColor: "rgba(255,255,255,0.10)",
        borderWidth: 1,
        cornerRadius: 2,
        padding: 10,
        titleFont: { family: MONO_FONT, size: 12 },
        bodyFont: { family: MONO_FONT, size: 12 },
        callbacks: {
          title: (items) => {
            const idx = items[0]?.dataIndex ?? 0;
            const iso = records[idx]?.period ?? "";
            const dayType = getDayType(iso);
            const dayLabels: Record<string, string> = {
              holiday: "Public Holiday",
              school:  "School Holiday",
              weekend: "Weekend",
              normal:  "",
            };
            const label = items[0]?.label ?? "";
            const extra = dayLabels[dayType] ? ` · ${dayLabels[dayType]}` : "";
            return `${label}${extra}`;
          },
          label: (ctx) => {
            const y = ctx.parsed?.y;
            if (y == null) return "";
            const lbl = ctx.dataset.label ?? "";
            if (lbl.includes("Feels Like")) {
              return `  ${lbl}: ${y.toFixed(1)}°C`;
            }
            if (lbl.includes("AI Baseline")) {
              return `  ${lbl}`;
            }
            const cost = calculateCost(y, tariff);
            return `  ${y.toFixed(2)} ${unitLabel}  (≈ BND ${cost.toFixed(2)})`;
          },
        },
      },
    },
    scales: {
      x: {
        grid: { color: GRID_COLOR },
        ticks: {
          color: TICK_COLOR,
          font: { size: 10, family: MONO_FONT },
          maxRotation: 45,
          autoSkip: true,
          maxTicksLimit: Math.ceil(records.length / skipModulo),
          callback: function(_value, index) {
            return index % skipModulo === 0 ? this.getLabelForValue(index) : "";
          },
        },
      },
      y: {
        beginAtZero: true,
        title: {
          display: false,
        },
        grid: { color: GRID_COLOR },
        ticks: {
          color: TICK_COLOR,
          font: { size: 10, family: MONO_FONT },
          callback: function(value) {
            return Number(value).toLocaleString();
          },
        },
      },
      ...(showWeather
        ? {
            y2: {
              beginAtZero: false,
              position: "right" as const,
              title: {
                display: true,
                text: "°C",
                color: TICK_COLOR,
                font: { size: 10, family: MONO_FONT },
              },
              grid: { drawOnChartArea: false },
              ticks: {
                color: TICK_COLOR,
                font: { size: 10, family: MONO_FONT },
              },
            },
          }
        : {}),
    },
  };

  return (
    <div>
      {warning && (
        <p className="font-sans text-xs mb-2" style={{ color: "var(--accent-primary)" }}>{warning}</p>
      )}
      <div style={{ height: isMobile ? "280px" : "380px" }}>
        <Chart type="bar" data={data} options={{ ...options, maintainAspectRatio: false }} />
      </div>

      {/* Compact day-type legend — only when overlays active */}
      {(overlays?.showWeekends || overlays?.showHolidays || overlays?.showSchool) && (
        <div className="flex flex-wrap gap-4 mt-3">
          {overlays.showHolidays && (
            <span className="flex items-center gap-1.5 font-mono" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
              <span className="inline-block w-2 h-2 rounded-sm" style={{ background: "var(--color-holiday)", opacity: 0.8 }} />
              Public Holiday
            </span>
          )}
          {overlays.showSchool && (
            <span className="flex items-center gap-1.5 font-mono" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
              <span className="inline-block w-2 h-2 rounded-sm" style={{ background: "var(--color-school)", opacity: 0.8 }} />
              School Holiday
            </span>
          )}
          {overlays.showWeekends && (
            <span className="flex items-center gap-1.5 font-mono" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
              <span className="inline-block w-2 h-2 rounded-sm" style={{ background: "var(--color-weekend)", opacity: 0.8 }} />
              Weekend
            </span>
          )}
          <span className="flex items-center gap-1.5 font-mono" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
            <span className="inline-block w-2 h-2 rounded-sm" style={{ background: "rgba(70,130,210,0.65)" }} />
            Normal
          </span>
        </div>
      )}
    </div>
  );
}
