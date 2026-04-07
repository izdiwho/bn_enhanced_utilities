import { useState, useEffect, useCallback, FormEvent } from "react";
import { Dashboard } from "./Dashboard.js";
import {
  getConfig,
  getPinStatus,
  verifyPin,
  getPinToken,
  setPinToken,
  clearPinToken,
} from "../api/usms.js";
import type { Meter } from "../types/usms.js";

// ─── Loading / Error screens ──────────────────────────────────────────────────

function LoadingScreen({ message = "Connecting..." }: { message?: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--bg-deep)" }}>
      <div className="text-center space-y-3">
        <div
          className="w-8 h-8 rounded-full border-2 animate-spin mx-auto"
          style={{
            borderColor: "var(--border-medium)",
            borderTopColor: "var(--accent-primary)",
          }}
        />
        <p className="font-sans" style={{ fontSize: "14px", color: "var(--text-secondary)" }}>
          {message}
        </p>
      </div>
    </div>
  );
}

interface ErrorScreenProps {
  message: string;
  onRetry: () => void;
}

function ErrorScreen({ message, onRetry }: ErrorScreenProps) {
  return (
    <div className="min-h-screen flex items-center justify-center px-6" style={{ background: "var(--bg-deep)" }}>
      <div className="w-full max-w-sm space-y-4">
        <p
          className="font-sans font-medium"
          style={{ color: "var(--color-holiday)", fontSize: "11px", letterSpacing: "0.1em", textTransform: "uppercase" }}
        >
          Connection failed
        </p>
        <p className="font-sans" style={{ fontSize: "14px", color: "var(--text-primary)" }}>
          {message}
        </p>
        <p className="font-sans text-xs" style={{ color: "var(--text-tertiary)" }}>
          Make sure <code className="font-mono" style={{ color: "var(--text-secondary)" }}>USMS_IC</code> and{" "}
          <code className="font-mono" style={{ color: "var(--text-secondary)" }}>USMS_PASSWORD</code> are set in your{" "}
          <code className="font-mono" style={{ color: "var(--text-secondary)" }}>.env</code> file and the backend is running.
        </p>
        <button
          onClick={onRetry}
          className="font-sans text-xs font-medium transition-colors"
          style={{ color: "var(--accent-primary)" }}
        >
          Retry →
        </button>
      </div>
    </div>
  );
}

// ─── PIN Entry screen ─────────────────────────────────────────────────────────

interface PinScreenProps {
  onVerified: () => void;
}

function PinScreen({ onVerified }: PinScreenProps) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!pin.trim() || loading) return;

    setLoading(true);
    setError(null);

    try {
      const result = await verifyPin(pin.trim());
      if (result.ok && result.token) {
        setPinToken(result.token);
        onVerified();
      } else {
        const msg = result.error ?? "Invalid PIN";
        const remaining = result.remainingAttempts;
        setError(
          remaining != null && remaining < 5
            ? `${msg} (${remaining} attempts remaining)`
            : msg
        );
        setPin("");
      }
    } catch {
      setError("Could not reach backend");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6" style={{ background: "var(--bg-deep)" }}>
      <div className="w-full max-w-xs">
        <div className="mb-10">
          <div className="inline-block">
            <h1
              className="font-sans font-semibold"
              style={{
                color: "var(--text-primary)",
                fontSize: "16px",
                letterSpacing: "0.25em",
                textTransform: "uppercase",
              }}
            >
              Enhanced Utilities Tracker
            </h1>
            <div style={{ height: "2px", background: "var(--accent-primary)", marginTop: "2px" }} />
          </div>
          <p className="font-sans text-xs mt-1.5" style={{ color: "var(--text-tertiary)" }}>
            Enter your PIN to continue
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            placeholder="· · · ·"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            disabled={loading}
            autoFocus
            className="w-full font-mono text-center text-3xl py-3 rounded-lg border outline-none transition-colors"
            style={{
              background: "var(--bg-input)",
              borderColor: error ? "var(--color-holiday)" : "var(--border-medium)",
              color: "var(--text-primary)",
              letterSpacing: "0.5em",
            }}
            onFocus={(e) => {
              e.target.style.borderColor = "var(--accent-primary)";
            }}
            onBlur={(e) => {
              e.target.style.borderColor = error ? "var(--color-holiday)" : "var(--border-medium)";
            }}
          />

          {error && (
            <p className="font-sans text-xs text-center" style={{ color: "var(--color-holiday)" }}>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || !pin.trim()}
            className="w-full py-2.5 rounded-full font-sans text-sm font-medium transition-opacity disabled:opacity-40"
            style={{
              background: "var(--accent-primary)",
              color: "var(--bg-deep)",
            }}
          >
            {loading ? "Verifying..." : "Unlock"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export function App() {
  const [phase, setPhase] = useState<"checking" | "pin" | "loading" | "ready" | "error">("checking");
  const [meters, setMeters] = useState<Meter[]>([]);
  const [features, setFeatures] = useState<{ ai: boolean }>({ ai: false });
  const [error, setError] = useState<string | null>(null);

  // Ensure dark mode class is always on
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  const loadDashboard = useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      const config = await getConfig();
      setMeters(config.meters);
      setFeatures(config.features);
      setPhase("ready");
    } catch (err) {
      // If PIN token was rejected, go back to PIN screen
      if (err instanceof Error && err.message === "PIN required") {
        clearPinToken();
        setPhase("pin");
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to connect to backend");
      setPhase("error");
    }
  }, []);

  // On mount: check if PIN is required, then either show PIN screen or load dashboard
  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const status = await getPinStatus();
        if (cancelled) return;

        if (!status.required) {
          // No PIN needed — go straight to loading
          loadDashboard();
          return;
        }

        // PIN is required — check if we already have a valid token
        const existingToken = getPinToken();
        if (existingToken) {
          // Try loading with existing token — will fail if expired
          loadDashboard();
        } else {
          setPhase("pin");
        }
      } catch {
        if (!cancelled) {
          setError("Could not reach backend");
          setPhase("error");
        }
      }
    }
    init();
    return () => { cancelled = true; };
  }, [loadDashboard]);

  if (phase === "checking") return <LoadingScreen message="Loading..." />;
  if (phase === "pin") return <PinScreen onVerified={loadDashboard} />;
  if (phase === "loading") return <LoadingScreen />;
  if (phase === "error") return <ErrorScreen message={error ?? "Unknown error"} onRetry={() => window.location.reload()} />;

  return <Dashboard meters={meters} features={features} />;
}
