/**
 * WaterTankEstimator — water tank sizing tool for water meters.
 *
 * Kampong Grid styling:
 * - Tank size / coverage buttons: small capsules with 1px border
 *   Active: border + text in --color-water. Inactive: --border-subtle + --text-tertiary
 * - Coverage result: big font-mono number, bright
 * - Mode tabs: text with underline indicator
 *
 * Mode A (coverage → tank size):
 *  Given a desired coverage duration (days), what minimum tank size is needed?
 *
 * Mode B (tank size → coverage):
 *  Given a tank size, how many days of average consumption does it cover?
 */
import { useState } from "react";
import type { ConsumptionRecord } from "../types/usms.js";

interface WaterTankEstimatorProps {
  consumptionRecords: ConsumptionRecord[];
}

const COMMON_SIZES_L = [500, 1000, 2000, 5000];
const COVERAGE_PRESETS_DAYS = [1, 3, 7, 14, 30];

function formatDays(days: number): string {
  if (days < 1) return `${(days * 24).toFixed(1)} hours`;
  if (days >= 30) return `${(days / 30).toFixed(1)} months`;
  if (days >= 7) return `${(days / 7).toFixed(1)} weeks`;
  return `${days.toFixed(1)} days`;
}

export function WaterTankEstimator({ consumptionRecords }: WaterTankEstimatorProps) {
  const [mode, setMode] = useState<"coverage" | "size">("coverage");
  const [tankSizeLitres, setTankSizeLitres] = useState<number>(1000);
  const [customTankInput, setCustomTankInput] = useState("");
  const [useCustomTank, setUseCustomTank] = useState(false);
  const [coverageDays, setCoverageDays] = useState<number>(7);
  const [customCoverageInput, setCustomCoverageInput] = useState("");
  const [useCustomCoverage, setUseCustomCoverage] = useState(false);

  const sorted = [...consumptionRecords].sort((a, b) =>
    a.period.localeCompare(b.period)
  );
  const dayCount = sorted.length;
  const avgDailyM3 =
    dayCount > 0 ? sorted.reduce((s, r) => s + r.consumption, 0) / dayCount : 0;
  const avgDailyLitres = avgDailyM3 * 1000;

  const noData = avgDailyLitres <= 0;

  const activeTankLitres = useCustomTank
    ? parseFloat(customTankInput) || 0
    : tankSizeLitres;
  const computedCoverageDays =
    avgDailyLitres > 0 ? activeTankLitres / avgDailyLitres : 0;

  const activeCoverageDays = useCustomCoverage
    ? parseFloat(customCoverageInput) || 0
    : coverageDays;
  const requiredLitres = avgDailyLitres * activeCoverageDays;

  // Mode tab style — text with underline indicator
  function modeTabStyle(isActive: boolean): React.CSSProperties {
    return {
      color: isActive ? "var(--color-water)" : "var(--text-tertiary)",
      fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
      fontWeight: isActive ? 500 : 400,
      fontSize: "12px",
      borderBottom: isActive ? "1px solid var(--color-water)" : "1px solid transparent",
      paddingBottom: "2px",
      transition: "color 0.15s",
    };
  }

  // Capsule button style — 1px border, active: water color
  function sizeBtnStyle(isActive: boolean): React.CSSProperties {
    return {
      color: isActive ? "var(--color-water)" : "var(--text-tertiary)",
      fontFamily: "'IBM Plex Mono', monospace",
      fontWeight: isActive ? 500 : 400,
      fontSize: "11px",
      border: "1px solid",
      borderColor: isActive ? "var(--color-water)" : "var(--border-subtle)",
      padding: "10px 14px",
      minHeight: "44px",
      borderRadius: "999px",
      transition: "color 0.15s, border-color 0.15s",
      display: "inline-flex",
      alignItems: "center",
    };
  }

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
        Water Tank Estimator
      </p>

      {noData ? (
        <p className="font-sans text-sm" style={{ color: "var(--text-tertiary)" }}>
          Not enough water consumption history to run estimates.
        </p>
      ) : (
        <div className="space-y-4">
          {/* Average usage context */}
          <p className="font-sans text-xs" style={{ color: "var(--text-tertiary)" }}>
            Avg daily usage:{" "}
            <span className="font-mono" style={{ color: "var(--text-secondary)" }}>
              {avgDailyLitres.toFixed(0)} L
            </span>{" "}
            (<span className="font-mono">{avgDailyM3.toFixed(3)} m³</span>) from {dayCount} day{dayCount !== 1 ? "s" : ""}
          </p>

          {/* Mode tabs */}
          <div className="flex gap-5">
            <button style={modeTabStyle(mode === "coverage")} onClick={() => setMode("coverage")}>
              Tank → coverage
            </button>
            <button style={modeTabStyle(mode === "size")} onClick={() => setMode("size")}>
              Coverage → tank size
            </button>
          </div>

          {/* Mode A: tank size → coverage */}
          {mode === "coverage" && (
            <div className="space-y-3">
              <div>
                <p className="font-sans text-xs mb-2" style={{ color: "var(--text-tertiary)" }}>
                  Select tank size
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {COMMON_SIZES_L.map((size) => (
                    <button
                      key={size}
                      style={sizeBtnStyle(!useCustomTank && tankSizeLitres === size)}
                      onClick={() => {
                        setTankSizeLitres(size);
                        setUseCustomTank(false);
                      }}
                    >
                      {size >= 1000 ? `${size / 1000}kL` : `${size}L`}
                    </button>
                  ))}
                  <button
                    style={sizeBtnStyle(useCustomTank)}
                    onClick={() => setUseCustomTank(true)}
                  >
                    Custom
                  </button>
                </div>
                {useCustomTank && (
                  <div className="flex items-center gap-2 mt-2">
                    <input
                      type="number"
                      min="1"
                      placeholder="Litres"
                      value={customTankInput}
                      onChange={(e) => setCustomTankInput(e.target.value)}
                      className="font-mono w-28 text-xs px-2 py-1 rounded focus:outline-none"
                      style={{
                        background: "var(--bg-input)",
                        color: "var(--text-primary)",
                        border: "1px solid var(--border-medium)",
                      }}
                    />
                    <span className="font-sans text-xs" style={{ color: "var(--text-tertiary)" }}>litres</span>
                  </div>
                )}
              </div>

              {activeTankLitres > 0 && (
                <div>
                  <p className="font-mono font-semibold leading-none mb-1" style={{ color: "var(--text-primary)", fontSize: "24px" }}>
                    {formatDays(computedCoverageDays)}
                  </p>
                  <p className="font-sans text-xs mb-3" style={{ color: "var(--text-secondary)" }}>
                    of coverage
                  </p>
                  <p className="font-sans text-xs mb-3" style={{ color: "var(--text-tertiary)" }}>
                    <span className="font-mono">
                      {activeTankLitres >= 1000
                        ? `${(activeTankLitres / 1000).toFixed(1)} kL`
                        : `${activeTankLitres} L`}
                    </span>{" "}
                    tank at <span className="font-mono">{avgDailyLitres.toFixed(0)} L/day</span>
                  </p>

                  {/* Coverage badges */}
                  <div className="flex flex-wrap gap-1.5">
                    {COVERAGE_PRESETS_DAYS.map((d) => {
                      const isAchieved = computedCoverageDays >= d;
                      return (
                        <span
                          key={d}
                          className="font-mono"
                          style={{
                            fontSize: "11px",
                            padding: "2px 8px",
                            borderRadius: "999px",
                            color: isAchieved ? "var(--color-water)" : "var(--text-tertiary)",
                            background: isAchieved ? "rgba(58,143,154,0.1)" : "var(--bg-raised)",
                            fontWeight: isAchieved ? 500 : 400,
                            border: "1px solid",
                            borderColor: isAchieved ? "var(--color-water)" : "transparent",
                          }}
                        >
                          {d}d {isAchieved ? "✓" : "·"}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Mode B: coverage target → tank size */}
          {mode === "size" && (
            <div className="space-y-3">
              <div>
                <p className="font-sans text-xs mb-2" style={{ color: "var(--text-tertiary)" }}>
                  Select desired coverage
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {COVERAGE_PRESETS_DAYS.map((d) => (
                    <button
                      key={d}
                      style={sizeBtnStyle(!useCustomCoverage && coverageDays === d)}
                      onClick={() => {
                        setCoverageDays(d);
                        setUseCustomCoverage(false);
                      }}
                    >
                      {d}d
                    </button>
                  ))}
                  <button
                    style={sizeBtnStyle(useCustomCoverage)}
                    onClick={() => setUseCustomCoverage(true)}
                  >
                    Custom
                  </button>
                </div>
                {useCustomCoverage && (
                  <div className="flex items-center gap-2 mt-2">
                    <input
                      type="number"
                      min="1"
                      placeholder="Days"
                      value={customCoverageInput}
                      onChange={(e) => setCustomCoverageInput(e.target.value)}
                      className="font-mono w-20 text-xs px-2 py-1 rounded focus:outline-none"
                      style={{
                        background: "var(--bg-input)",
                        color: "var(--text-primary)",
                        border: "1px solid var(--border-medium)",
                      }}
                    />
                    <span className="font-sans text-xs" style={{ color: "var(--text-tertiary)" }}>days</span>
                  </div>
                )}
              </div>

              {activeCoverageDays > 0 && (
                <div>
                  <p className="font-mono font-semibold leading-none mb-1" style={{ color: "var(--text-primary)", fontSize: "24px" }}>
                    {requiredLitres >= 1000
                      ? `${(requiredLitres / 1000).toFixed(2)} kL`
                      : `${Math.ceil(requiredLitres)} L`}
                  </p>
                  <p className="font-sans text-xs mb-1" style={{ color: "var(--text-secondary)" }}>
                    needed
                  </p>
                  <p className="font-sans text-xs mt-1" style={{ color: "var(--text-tertiary)" }}>
                    for <span className="font-mono">{activeCoverageDays}</span> day{activeCoverageDays !== 1 ? "s" : ""} at{" "}
                    <span className="font-mono">{avgDailyLitres.toFixed(0)} L/day</span>
                  </p>
                  {(() => {
                    const nearest = COMMON_SIZES_L.find((s) => s >= requiredLitres);
                    return nearest ? (
                      <p className="font-sans text-xs mt-1" style={{ color: "var(--color-water)", opacity: 0.85 }}>
                        Nearest standard:{" "}
                        <span className="font-mono">
                          {nearest >= 1000 ? `${nearest / 1000} kL` : `${nearest} L`}
                        </span>
                      </p>
                    ) : null;
                  })()}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
