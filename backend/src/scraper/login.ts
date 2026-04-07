/**
 * SmartMeter login flow.
 *
 * IC format: WITHOUT dashes — "01234567" not "01-234567".
 * This was discovered via live testing: the site returns HTTP 302 to
 * /SmartMeter/LoginSession when IC has no dashes, and "wrong password"
 * when dashes are present.
 *
 * SECURITY: password is NEVER logged or persisted.
 */
import { usmsGet, usmsPost, CookieJar, USMS_BASE_URL } from "./client.js";
import { extractViewState } from "./parsers.js";

export interface LoginResult {
  success: boolean;
  cookies: CookieJar;
  homeHtml: string; // HTML of /SmartMeter/Home (meter card data)
  /** Populated if login failed */
  error?: string;
}

const LOGIN_PATH = "/SmartMeter/ResLogin";

/**
 * Strip dashes from IC number for login.
 * "01-234567" → "01234567"
 */
export function normaliseIc(icNumber: string): string {
  return icNumber.replace(/-/g, "").trim();
}

export async function loginToUsms(
  icNumber: string,
  password: string
): Promise<LoginResult> {
  const jar: CookieJar = new Map();
  const normIc = normaliseIc(icNumber);

  // Step 1: GET the login page to capture VIEWSTATE + session cookie
  const getResult = await usmsGet(LOGIN_PATH, jar);
  if (getResult.status !== 200) {
    return {
      success: false,
      cookies: jar,
      homeHtml: "",
      error: `GET ResLogin failed: HTTP ${getResult.status}`,
    };
  }

  const vs = extractViewState(getResult.html);

  // Step 2: POST credentials
  // Field names from live form inspection:
  //   type=text      name=ASPxRoundPanel1$txtUsername
  //   type=password  name=ASPxRoundPanel1$txtPassword
  //   type=submit    name=ASPxRoundPanel1$btnLogin value=Login
  const body = new URLSearchParams();
  body.set("__EVENTTARGET", "");
  body.set("__EVENTARGUMENT", "");
  body.set("__VIEWSTATE", vs.__VIEWSTATE);
  body.set("__VIEWSTATEGENERATOR", vs.__VIEWSTATEGENERATOR);
  body.set("__EVENTVALIDATION", vs.__EVENTVALIDATION);
  body.set("ASPxRoundPanel1$txtUsername", normIc); // IC without dashes
  body.set("ASPxRoundPanel1$txtPassword", password); // never logged
  body.set("ASPxRoundPanel1$btnLogin", "Login");
  body.set("ASPxHiddenField1", vs.__ASPxHiddenField1 ?? "");

  const postResult = await usmsPost(LOGIN_PATH, body, jar, {
    Referer: `${USMS_BASE_URL}${LOGIN_PATH}`,
    Origin: USMS_BASE_URL,
  });

  if (postResult.redirectedToLogin) {
    return {
      success: false,
      cookies: jar,
      homeHtml: "",
      error: "Invalid credentials or session expired",
    };
  }

  // On success: server 302s to /SmartMeter/LoginSession?... → /SmartMeter/MainPage
  // Our client follows those. The final URL should include "Home" or "MainPage".
  const onHome =
    postResult.finalUrl.toLowerCase().includes("home") ||
    postResult.finalUrl.toLowerCase().includes("mainpage") ||
    postResult.html.toLowerCase().includes("mainpage");

  if (!onHome || postResult.status >= 400) {
    return {
      success: false,
      cookies: jar,
      homeHtml: "",
      error: `Login failed: unexpected final URL ${postResult.finalUrl} (HTTP ${postResult.status})`,
    };
  }

  // Step 3: Explicitly fetch /SmartMeter/Home which contains the meter cards
  // (MainPage is the shell frame, Home is the iframe content with actual data)
  const homeResult = await usmsGet("/SmartMeter/Home", jar);
  if (homeResult.redirectedToLogin || homeResult.status >= 400) {
    return {
      success: false,
      cookies: jar,
      homeHtml: "",
      error: `Could not load Home page after login (HTTP ${homeResult.status})`,
    };
  }

  return {
    success: true,
    cookies: jar,
    homeHtml: homeResult.html,
  };
}
