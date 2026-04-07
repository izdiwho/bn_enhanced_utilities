/**
 * Single-user session for auto-login.
 *
 * Credentials come from USMS_IC + USMS_PASSWORD env vars.
 * No tokens, no session map — one user, one server-held session.
 *
 * ensureSession() returns the active session, re-logging in if:
 *   - no session exists yet, or
 *   - the session is older than 20 minutes (proactive refresh).
 *
 * clearSession() is called when the upstream portal returns a login redirect
 * so the next request triggers a fresh login.
 */
import { loginToUsms } from "./scraper/login.js";
import { parseHomePage } from "./scraper/mainPage.js";
import type { CookieJar } from "./scraper/client.js";
import type { Meter } from "./scraper/mainPage.js";

export interface UsmsSession {
  cookies: CookieJar;
  viewState: string | null;
  viewStateGenerator: string | null;
  eventValidation: string | null;
  meters: Meter[];
  /** meterNo → reportParam */
  reportParams: Map<string, string>;
  lastLoginAt: number;
}

const SESSION_REFRESH_MS = 20 * 60 * 1000; // 20 min

let session: UsmsSession | null = null;
let loginInProgress: Promise<UsmsSession> | null = null;

export async function ensureSession(): Promise<UsmsSession> {
  // If a login is already in progress, wait for it rather than double-logging in
  if (loginInProgress) return loginInProgress;

  if (session && Date.now() - session.lastLoginAt < SESSION_REFRESH_MS) {
    return session;
  }

  loginInProgress = (async () => {
    const ic = process.env.USMS_IC;
    const pw = process.env.USMS_PASSWORD;
    if (!ic || !pw) {
      throw new Error("USMS_IC and USMS_PASSWORD must be set in .env");
    }

    console.log("[session] Logging in to SmartMeter portal...");
    const result = await loginToUsms(ic, pw);
    if (!result.success) {
      throw new Error("SmartMeter login failed: " + (result.error ?? "unknown error"));
    }

    const meters = parseHomePage(result.homeHtml);
    const reportParams = new Map<string, string>();
    for (const m of meters) {
      if (m.reportParam) reportParams.set(m.meterNo, m.reportParam);
    }

    session = {
      cookies: result.cookies,
      viewState: null,
      viewStateGenerator: null,
      eventValidation: null,
      meters,
      reportParams,
      lastLoginAt: Date.now(),
    };
    console.log(`[session] Logged in. ${meters.length} meter(s) found.`);
    return session;
  })().finally(() => {
    loginInProgress = null;
  });

  return loginInProgress;
}

export function getSession(): UsmsSession | null {
  return session;
}

export function clearSession(): void {
  session = null;
  console.log("[session] Session cleared — will re-login on next request.");
}
