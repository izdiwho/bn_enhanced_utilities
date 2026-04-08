/**
 * ScrapeStatus — shows last sync time + manual refresh button.
 *
 * Displays:
 *   "Last synced 3 minutes ago" (if available)
 *   "Syncing..." (if running)
 *   "Sync now" button (manual trigger with debounce)
 */

import { useState, useEffect } from "react";
import { getScrapeStatus, triggerScrape, type ScrapeStatusResponse } from "../api/usms.js";

interface ScrapeStatusProps {
  onSyncStart?: () => void;
  onSyncComplete?: () => void;
}

function formatTimeDiff(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hour = Math.floor(min / 60);
  const day = Math.floor(hour / 24);

  if (day > 0) return `${day}d ago`;
  if (hour > 0) return `${hour}h ago`;
  if (min > 0) return `${min}m ago`;
  return "just now";
}

export function ScrapeStatus({ onSyncStart, onSyncComplete }: ScrapeStatusProps) {
  const [status, setStatus] = useState<ScrapeStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch status on mount and set up polling
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const data = await getScrapeStatus();
        setStatus(data);
        setError(null);
      } catch (err) {
        console.error("[ScrapeStatus] Failed to fetch status:", err);
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 30000); // Poll every 30 seconds
    return () => clearInterval(interval);
  }, []);

  const handleSync = async () => {
    if (loading || status?.running) return;

    setLoading(true);
    setError(null);
    onSyncStart?.();

    try {
      await triggerScrape();
      // Poll for status update
      await new Promise((resolve) => setTimeout(resolve, 500));
      const data = await getScrapeStatus();
      setStatus(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
      console.error("[ScrapeStatus] Failed to trigger sync:", err);
    } finally {
      setLoading(false);
      onSyncComplete?.();
    }
  };

  const lastSyncTime =
    status?.lastScrape?.finishedAt ?? status?.lastScrape?.startedAt;
  const isRunning = status?.running || loading;
  const lastSyncText = lastSyncTime
    ? formatTimeDiff(Date.now() - lastSyncTime)
    : "never";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        fontSize: "13px",
        color: "var(--text-secondary)",
      }}
    >
      {/* Status text */}
      <span>
        {isRunning ? (
          <>
            <span style={{ display: "inline-block", animation: "pulse 1s infinite" }}>
              ●
            </span>{" "}
            Syncing...
          </>
        ) : (
          <>Last synced {lastSyncText}</>
        )}
      </span>

      {/* Sync button */}
      <button
        onClick={handleSync}
        disabled={isRunning}
        style={{
          padding: "6px 12px",
          borderRadius: "4px",
          border: "1px solid var(--border-color)",
          background: isRunning ? "var(--bg-muted)" : "var(--bg-raised)",
          color: "var(--text-secondary)",
          cursor: isRunning ? "not-allowed" : "pointer",
          fontSize: "12px",
          fontWeight: 500,
          transition: "all 200ms",
          opacity: isRunning ? 0.5 : 1,
        }}
      >
        {isRunning ? "Syncing..." : "Sync now"}
      </button>

      {/* Error message */}
      {error && (
        <span style={{ color: "var(--color-error)", fontSize: "12px" }}>
          {error}
        </span>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}
