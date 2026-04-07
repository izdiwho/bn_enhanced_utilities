/**
 * Backend API client.
 *
 * No session tokens — the backend authenticates automatically via env vars.
 * All requests are unauthenticated from the browser's perspective.
 */
import type {
  ConfigResponse,
  AccountResponse,
  ConsumptionHistoryResponse,
  TopUpHistoryResponse,
} from "../types/usms.js";

const API_BASE = "/api";

// ─── PIN token management ────────────────────────────────────────────────────

const PIN_TOKEN_KEY = "usms_pin_token";

export function getPinToken(): string | null {
  return localStorage.getItem(PIN_TOKEN_KEY);
}

export function setPinToken(token: string): void {
  localStorage.setItem(PIN_TOKEN_KEY, token);
}

export function clearPinToken(): void {
  localStorage.removeItem(PIN_TOKEN_KEY);
}

// ─── Request helpers ─────────────────────────────────────────────────────────

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: { error: string }
  ) {
    super(body.error);
    this.name = "ApiRequestError";
  }
}

async function request<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  force = false
): Promise<T> {
  const url = `${API_BASE}${path}${force ? "?force=true" : ""}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getPinToken();
  if (token) headers["X-Pin-Token"] = token;

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new ApiRequestError(res.status, data as { error: string });
  }
  return data as T;
}

// ─── PIN endpoints ───────────────────────────────────────────────────────────

export async function getPinStatus(): Promise<{ required: boolean }> {
  const res = await fetch(`${API_BASE}/pin/status`);
  return res.json();
}

export async function verifyPin(pin: string): Promise<{ ok: boolean; token?: string; error?: string; remainingAttempts?: number }> {
  const res = await fetch(`${API_BASE}/pin/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin }),
  });
  return res.json();
}

// ─── Config ───────────────────────────────────────────────────────────────────

export async function getConfig(): Promise<ConfigResponse> {
  return request<ConfigResponse>("GET", "/config");
}

// ─── Account ──────────────────────────────────────────────────────────────────

export async function getAccount(force = false): Promise<AccountResponse> {
  return request<AccountResponse>("POST", "/account", {}, force);
}

export async function getMeterDetails(meterNo: string, force = false) {
  return request("POST", "/meter-details", { meterNo }, force);
}

// ─── Consumption history ──────────────────────────────────────────────────────

export async function getConsumptionHistory(
  meterNo: string,
  startDate: string,
  endDate: string,
  force = false
): Promise<ConsumptionHistoryResponse> {
  return request<ConsumptionHistoryResponse>(
    "POST",
    "/consumption-history",
    { meterNo, startDate, endDate },
    force
  );
}

// ─── Topup history ────────────────────────────────────────────────────────────

export async function getTopupHistory(
  meterNo: string,
  startDate: string,
  endDate: string,
  force = false
): Promise<TopUpHistoryResponse> {
  return request<TopUpHistoryResponse>(
    "POST",
    "/topup-history",
    { meterNo, startDate, endDate },
    force
  );
}

// ─── AI estimate ──────────────────────────────────────────────────────────────

export interface ApplianceBreakdownItem {
  name: string;
  /** New format: min/max range */
  estimatedKwhPerMonthMin?: number;
  estimatedKwhPerMonthMax?: number;
  /** Legacy format: single value (kept for backward compatibility) */
  estimatedKwhPerMonth?: number;
  percentOfTotal: number;
}

export interface EstimateBaselineResponse {
  appliancesJson: {
    appliances?: ApplianceBreakdownItem[];
    notes?: string;
  } | null;
  rawText: string;
}

export async function estimateBaseline(
  monthlyKwh: number,
  applianceList?: string[]
): Promise<EstimateBaselineResponse> {
  return request<EstimateBaselineResponse>("POST", "/ai/estimate-baseline", {
    monthlyKwh,
    applianceList,
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns true for any HTTP error (used by components to show generic error UI). */
export function isSessionExpired(_err: unknown): boolean {
  // In single-user mode there are no sessions to expire from the client's view.
  // Keep this for backward compatibility — always returns false.
  return false;
}
