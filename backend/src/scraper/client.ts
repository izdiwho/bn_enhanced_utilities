/**
 * HTTP client wrapper with manual cookie jar for SmartMeter scraping.
 * Uses undici fetch (Node 18+). NEVER logs passwords.
 *
 * Exports:
 *  - usmsGet         — GET a page, follows redirects, maintains cookie jar.
 *  - usmsPost        — POST form data, follows redirects, maintains cookie jar.
 *  - getDxState      — POST ASPxHiddenField1 callback to retrieve encrypted DX state.
 *  - usmsFetchBinary — POST form data and return raw Buffer (for Excel downloads).
 *  - extractHiddenFromDelta — Parse hidden fields from MS Ajax delta response.
 */
import { fetch, Headers } from "undici";

export const USMS_BASE_URL =
  process.env.USMS_BASE_URL ?? "https://www.usms.com.bn";

export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type CookieJar = Map<string, string>;

/**
 * Parse Set-Cookie headers from a Response and merge them into the jar.
 */
export function mergeSetCookies(headers: Headers, jar: CookieJar): void {
  const raw: string[] = (headers as any).getSetCookie
    ? (headers as any).getSetCookie()
    : [headers.get("set-cookie") ?? ""].filter(Boolean);

  for (const cookie of raw) {
    const [nameVal] = cookie.split(";");
    const eqIdx = nameVal.indexOf("=");
    if (eqIdx === -1) continue;
    const name = nameVal.slice(0, eqIdx).trim();
    const value = nameVal.slice(eqIdx + 1).trim();
    if (name) jar.set(name, value);
  }
}

/**
 * Serialise cookie jar into a Cookie header value.
 */
export function serialiseCookies(jar: CookieJar): string {
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

export interface FetchResult {
  status: number;
  finalUrl: string;
  html: string;
  redirectedToLogin: boolean;
}

/**
 * GET a page, following redirects and maintaining the cookie jar.
 * Returns redirectedToLogin=true if the server sent us back to ResLogin.
 */
export async function usmsGet(
  path: string,
  jar: CookieJar,
  extraHeaders?: Record<string, string>
): Promise<FetchResult> {
  return usmsFetch("GET", path, jar, undefined, extraHeaders);
}

/**
 * POST to a page, following redirect and maintaining the cookie jar.
 */
export async function usmsPost(
  path: string,
  body: URLSearchParams,
  jar: CookieJar,
  extraHeaders?: Record<string, string>
): Promise<FetchResult> {
  return usmsFetch("POST", path, jar, body, extraHeaders);
}

/**
 * Call an ASPxHiddenField1 (DevExpress) callback to get/refresh encrypted state.
 *
 * Response format: <len>|<encrypted_state>|[DX JS]...
 * We extract the encrypted_state portion (between first and second pipe).
 */
export async function getDxState(
  path: string,
  jar: CookieJar,
  vs: Record<string, string>,
  formFields: Record<string, string>
): Promise<string> {
  const url = path.startsWith("http") ? path : `${USMS_BASE_URL}${path}`;
  const body = new URLSearchParams();
  body.set("__CALLBACKID",         "ASPxHiddenField1");
  body.set("__CALLBACKPARAM",      "c0:");
  body.set("__EVENTTARGET",        "");
  body.set("__EVENTARGUMENT",      "");
  body.set("__VIEWSTATE",          vs.__VIEWSTATE ?? "");
  body.set("__VIEWSTATEGENERATOR", vs.__VIEWSTATEGENERATOR ?? "");
  body.set("__EVENTVALIDATION",    vs.__EVENTVALIDATION ?? "");
  body.set("ASPxHiddenField1",     "");
  for (const [k, v] of Object.entries(formFields)) body.set(k, v);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent":   DEFAULT_UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie":       serialiseCookies(jar),
      "Referer":      url,
    },
    body: body.toString(),
    redirect: "follow",
  });
  mergeSetCookies(res.headers as Headers, jar);
  const respText = await res.text();

  // Format: <len>|<state_string>|/*DX*/...
  // Extract state between first and second pipe.
  const firstPipe = respText.indexOf("|");
  if (firstPipe === -1) return "";
  const len = parseInt(respText.slice(0, firstPipe), 10);
  if (isNaN(len) || len <= 0) return "";
  return respText.slice(firstPipe + 1, firstPipe + 1 + len);
}

/**
 * POST form data and return the raw response body as a Buffer.
 * Used for Excel export endpoints (btnExportXlsx).
 * Does NOT follow redirects as a login-redirect means session expired.
 */
export async function usmsFetchBinary(
  path: string,
  body: URLSearchParams,
  jar: CookieJar
): Promise<Buffer> {
  const url = path.startsWith("http") ? path : `${USMS_BASE_URL}${path}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent":   DEFAULT_UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept":       "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel, */*",
      "Cookie":       serialiseCookies(jar),
      "Referer":      url,
    },
    body: body.toString(),
    redirect: "manual",
  });

  mergeSetCookies(res.headers as Headers, jar);

  // If session expired the server redirects to ResLogin
  if (res.status >= 300 && res.status < 400) {
    const location = (res.headers.get("location") ?? "").toLowerCase();
    if (location.includes("reslogin") || location.includes("/login")) {
      throw new Error("session_expired");
    }
    // Other redirects — follow once
    const redirectUrl = res.headers.get("location") ?? "";
    const r2 = await fetch(redirectUrl.startsWith("http") ? redirectUrl : `${USMS_BASE_URL}${redirectUrl}`, {
      headers: {
        "User-Agent": DEFAULT_UA,
        "Cookie":     serialiseCookies(jar),
      },
      redirect: "manual",
    });
    mergeSetCookies(r2.headers as Headers, jar);
    const ab = await r2.arrayBuffer();
    return Buffer.from(ab);
  }

  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * POST with X-MicrosoftAjax: Delta=true header to trigger an UpdatePanel
 * partial-page refresh. Returns the raw delta response text.
 *
 * Used as an intermediate step before export: the UpdatePanel response
 * contains a refreshed __EVENTVALIDATION that registers btnExportXlsx as a
 * valid postback target. Without this step the export POST receives a 500.
 */
export async function usmsUpdatePanelPost(
  path: string,
  body: URLSearchParams,
  jar: CookieJar
): Promise<string> {
  const url = path.startsWith("http") ? path : `${USMS_BASE_URL}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent":    DEFAULT_UA,
      "Content-Type":  "application/x-www-form-urlencoded; charset=utf-8",
      "Cookie":        serialiseCookies(jar),
      "X-MicrosoftAjax": "Delta=true",
      "Cache-Control": "no-cache",
      "Referer":       url,
    },
    body: body.toString(),
    redirect: "follow",
  });
  mergeSetCookies(res.headers as Headers, jar);
  return res.text();
}

/**
 * Extract UpdatePanel HTML content from an MS Ajax delta response.
 * Format: ...<len>|updatePanel|<panelId>|<html>...
 */
export function extractUpdatePanelContent(delta: string, panelId = "UpdatePanel1"): string {
  const marker = `|updatePanel|${panelId}|`;
  const idx = delta.indexOf(marker);
  if (idx === -1) return "";
  const before = delta.slice(0, idx);
  const lastPipePos = before.lastIndexOf("|");
  const len = parseInt(before.slice(lastPipePos + 1), 10);
  if (isNaN(len) || len <= 0) return "";
  return delta.slice(idx + marker.length, idx + marker.length + len);
}

/**
 * Parse MS Ajax UpdatePanel delta response and extract hidden fields.
 * Format: <len>|hiddenField|<name>|<value>...
 */
export function extractHiddenFromDelta(delta: string): Record<string, string> {
  const result: Record<string, string> = {};
  const re = /(\d+)\|hiddenField\|([^|]+)\|/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(delta)) !== null) {
    const len = parseInt(m[1], 10);
    const name = m[2];
    const valueStart = m.index + m[0].length;
    result[name] = delta.slice(valueStart, valueStart + len);
  }
  return result;
}

async function usmsFetch(
  method: "GET" | "POST",
  path: string,
  jar: CookieJar,
  body?: URLSearchParams,
  extraHeaders?: Record<string, string>
): Promise<FetchResult> {
  const url = path.startsWith("http") ? path : `${USMS_BASE_URL}${path}`;

  const headers: Record<string, string> = {
    "User-Agent":      DEFAULT_UA,
    "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Connection":      "keep-alive",
    Cookie:            serialiseCookies(jar),
    ...extraHeaders,
  };

  if (body) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body?.toString(),
    redirect: "manual",
  });

  mergeSetCookies(response.headers as Headers, jar);

  // Handle redirect
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "";
    const locLower = location.toLowerCase();

    // Only treat as login redirect if location explicitly points back to login,
    // not to LoginSession (part of the login success chain) or other pages.
    const redirectedToLogin =
      (locLower.includes("reslogin") || locLower.includes("/login")) &&
      !locLower.includes("loginsession") &&
      !locLower.includes("mainpage") &&
      !locLower.includes("home");

    if (redirectedToLogin) {
      return { status: response.status, finalUrl: location, html: "", redirectedToLogin: true };
    }

    // Follow the redirect
    const redirectUrl = location.startsWith("http")
      ? location
      : `${USMS_BASE_URL}${location}`;
    return usmsFetch("GET", redirectUrl, jar);
  }

  const html = await response.text();

  // The server may re-render ResLogin inline (session expired).
  // Only flag as redirectedToLogin if we're seeing a login form on a page
  // we did NOT intentionally navigate to.
  const htmlLower = html.toLowerCase();
  const isLoginFormPage =
    htmlLower.includes("asp_roundpanel1_btnlogin") ||
    (htmlLower.includes("txtusername") && htmlLower.includes("txtpassword") && htmlLower.includes("btnlogin"));
  const isSessionExpire =
    url.toLowerCase().includes("sessionexpire") || htmlLower.includes("sessionexpire");
  const isIntentionalLoginFetch = url.toLowerCase().includes("reslogin");

  const redirectedToLogin = (isLoginFormPage || isSessionExpire) && !isIntentionalLoginFetch;

  return {
    status: response.status,
    finalUrl: url,
    html,
    redirectedToLogin,
  };
}
