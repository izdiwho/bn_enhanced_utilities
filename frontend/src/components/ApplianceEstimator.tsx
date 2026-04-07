/**
 * ApplianceEstimator — AI-powered appliance breakdown for electricity meters.
 *
 * Kampong Grid styling:
 * - Textarea: --bg-input, font-mono placeholder, warm border
 * - Submit button: capsule shape (rounded-full), accent bg
 * - Results table: font-mono values, tight spacing
 * - kWh column shows min–max range (e.g. "80–160")
 * - Cost column shows min–max cost range
 * - Backward compatible: if AI returns old estimatedKwhPerMonth, uses it for both min and max
 */
import { useState, FormEvent } from "react";
import type { ConsumptionRecord } from "../types/usms.js";
import { estimateBaseline, type ApplianceBreakdownItem } from "../api/usms.js";
import { calculateCost, ELECTRICITY_TARIFF } from "../utils/tariff.js";

interface ApplianceEstimatorProps {
  consumptionRecords: ConsumptionRecord[];
  /** Called when a successful estimate is returned, with mid/min/max total monthly kWh. */
  onBaselineEstimated?: (midMonthlyKwh: number, minMonthlyKwh: number, maxMonthlyKwh: number) => void;
}

const PLACEHOLDER = `e.g. 3 aircons running 9 hours/day, 1 fridge (always on), washing machine 5 times/week, water heater 30 min/day`;

/** Resolve min/max from an item that may have old or new format */
function resolveRange(item: ApplianceBreakdownItem): { min: number; max: number } {
  if (item.estimatedKwhPerMonthMin != null && item.estimatedKwhPerMonthMax != null) {
    return { min: item.estimatedKwhPerMonthMin, max: item.estimatedKwhPerMonthMax };
  }
  // Backward compat: old single-value field
  const val = item.estimatedKwhPerMonth ?? 0;
  return { min: val, max: val };
}

export function ApplianceEstimator({
  consumptionRecords,
  onBaselineEstimated,
}: ApplianceEstimatorProps) {
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApplianceBreakdownItem[] | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [rawText, setRawText] = useState<string | null>(null);

  // Average monthly kWh — records are daily, so multiply daily avg by 30
  const totalKwh = consumptionRecords.reduce((s, r) => s + r.consumption, 0);
  const avgDailyKwh = consumptionRecords.length > 0 ? totalKwh / consumptionRecords.length : 0;
  const avgMonthlyKwh = avgDailyKwh * 30;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!description.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setNotes(null);
    setRawText(null);
    setUnavailable(false);

    const applianceList = description
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      const res = await estimateBaseline(avgMonthlyKwh, applianceList);
      setRawText(res.rawText);
      if (res.appliancesJson?.appliances) {
        setResult(res.appliancesJson.appliances);
        setNotes(res.appliancesJson.notes ?? null);
        if (onBaselineEstimated) {
          let totalMin = 0, totalMax = 0;
          for (const a of res.appliancesJson.appliances) {
            const { min, max } = resolveRange(a);
            totalMin += min;
            totalMax += max;
          }
          const totalMid = (totalMin + totalMax) / 2;
          onBaselineEstimated(totalMid, totalMin, totalMax);
        }
      } else {
        setError("The AI returned an unexpected format. Raw response shown below.");
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("not configured")) {
        setUnavailable(true);
        return;
      }
      setError(err instanceof Error ? err.message : "Estimation failed.");
    } finally {
      setLoading(false);
    }
  }

  // Total range across all appliances
  const totalMin = result ? result.reduce((s, a) => s + resolveRange(a).min, 0) : 0;
  const totalMax = result ? result.reduce((s, a) => s + resolveRange(a).max, 0) : 0;
  const totalCostMin = calculateCost(totalMin, ELECTRICITY_TARIFF);
  const totalCostMax = calculateCost(totalMax, ELECTRICITY_TARIFF);

  // If AI is unavailable, render nothing — Dashboard already gates this with features.ai
  if (unavailable) return null;

  return (
    <div>
      <p
        className="font-sans font-medium uppercase mb-3"
        style={{
          color: "var(--text-tertiary)",
          fontSize: "11px",
          letterSpacing: "0.12em",
        }}
      >
        Appliance Estimator
      </p>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <textarea
            rows={3}
            placeholder={PLACEHOLDER}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={loading}
            className="w-full font-mono text-xs px-3 py-2.5 rounded focus:outline-none resize-none disabled:opacity-50 transition-colors"
            style={{
              background: "var(--bg-input)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-medium)",
            }}
          />
          {avgMonthlyKwh > 0 && (
            <p className="font-sans text-xs mt-1" style={{ color: "var(--text-tertiary)" }}>
              Your average monthly usage:{" "}
              <span className="font-mono" style={{ color: "var(--text-secondary)" }}>
                {avgMonthlyKwh.toFixed(0)} kWh/mo
              </span>{" "}
              ({avgDailyKwh.toFixed(1)} kWh/day) — used as calibration anchor.
            </p>
          )}
        </div>

        {error && (
          <p className="font-sans text-xs" style={{ color: "var(--color-holiday)" }}>{error}</p>
        )}

        <button
          type="submit"
          disabled={loading || !description.trim()}
          className="font-sans text-sm font-medium px-5 py-2 rounded-full disabled:opacity-50 transition-opacity"
          style={{
            background: "var(--accent-primary)",
            color: "var(--bg-deep)",
          }}
        >
          {loading ? "Estimating..." : "Estimate"}
        </button>
      </form>

      {/* Results table — min–max range */}
      {result && result.length > 0 && (
        <div className="mt-5 space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border-medium)" }}>
                  <th
                    className="font-sans font-medium text-left py-2 uppercase"
                    style={{ color: "var(--text-tertiary)", letterSpacing: "0.08em", fontSize: "11px" }}
                  >
                    Appliance
                  </th>
                  <th
                    className="font-sans font-medium text-right py-2 uppercase"
                    style={{ color: "var(--text-tertiary)", letterSpacing: "0.08em", fontSize: "11px" }}
                  >
                    kWh/mo
                  </th>
                  <th
                    className="font-sans font-medium text-right py-2 uppercase"
                    style={{ color: "var(--text-tertiary)", letterSpacing: "0.08em", fontSize: "11px" }}
                  >
                    %
                  </th>
                  <th
                    className="font-sans font-medium text-right py-2 uppercase"
                    style={{ color: "var(--text-tertiary)", letterSpacing: "0.08em", fontSize: "11px" }}
                  >
                    BND/mo
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.map((item, i) => {
                  const { min, max } = resolveRange(item);
                  const costMin = calculateCost(min, ELECTRICITY_TARIFF);
                  const costMax = calculateCost(max, ELECTRICITY_TARIFF);
                  const isSingle = min === max;
                  return (
                    <tr
                      key={i}
                      style={{ borderBottom: "1px solid var(--border-subtle)" }}
                    >
                      <td className="font-sans py-2" style={{ color: "var(--text-primary)" }}>
                        {item.name}
                      </td>
                      <td className="font-mono py-2 text-right" style={{ color: "var(--text-secondary)" }}>
                        {isSingle
                          ? min.toFixed(1)
                          : `${min.toFixed(0)}–${max.toFixed(0)}`}
                      </td>
                      <td className="font-mono py-2 text-right" style={{ color: "var(--text-tertiary)" }}>
                        {item.percentOfTotal.toFixed(0)}%
                      </td>
                      <td className="font-mono py-2 text-right" style={{ color: "var(--text-secondary)" }}>
                        {isSingle
                          ? costMin.toFixed(2)
                          : `${costMin.toFixed(2)}–${costMax.toFixed(2)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: "1px solid var(--border-medium)" }}>
                  <td className="font-sans py-2 font-semibold" style={{ color: "var(--text-primary)" }}>
                    Total
                  </td>
                  <td className="font-mono py-2 text-right font-semibold" style={{ color: "var(--text-primary)" }}>
                    {totalMin === totalMax
                      ? totalMin.toFixed(1)
                      : `${totalMin.toFixed(0)}–${totalMax.toFixed(0)}`}
                  </td>
                  <td className="font-mono py-2 text-right" style={{ color: "var(--text-tertiary)" }}>
                    100%
                  </td>
                  <td className="font-mono py-2 text-right font-semibold" style={{ color: "var(--accent-primary)" }}>
                    {totalCostMin === totalCostMax
                      ? totalCostMin.toFixed(2)
                      : `${totalCostMin.toFixed(2)}–${totalCostMax.toFixed(2)}`}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {notes && (
            <p className="font-sans text-xs italic" style={{ color: "var(--text-tertiary)" }}>{notes}</p>
          )}

          <p className="font-sans text-xs" style={{ color: "var(--text-tertiary)", opacity: 0.7 }}>
            AI-generated estimates. Ranges reflect typical usage variation. Costs use Brunei domestic tariff tiers.
          </p>
        </div>
      )}

      {/* Fallback raw text if JSON parse failed */}
      {error && rawText && (
        <details className="mt-2">
          <summary className="font-sans text-xs cursor-pointer" style={{ color: "var(--text-tertiary)" }}>
            Show raw AI response
          </summary>
          <pre
            className="font-mono mt-1 text-xs whitespace-pre-wrap break-words p-2 rounded"
            style={{
              color: "var(--text-tertiary)",
              background: "var(--bg-raised)",
            }}
          >
            {rawText}
          </pre>
        </details>
      )}
    </div>
  );
}
