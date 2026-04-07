/**
 * Open-Meteo weather API helper.
 *
 * Fetches daily "feels like" temperature data for Brunei (Bandar Seri Begawan).
 * Open-Meteo is free, requires no API key, and supports CORS from the browser.
 *
 * Endpoint:
 *   GET https://api.open-meteo.com/v1/forecast
 *     ?latitude=4.9431&longitude=114.9425
 *     &daily=apparent_temperature_max,apparent_temperature_min
 *     &timezone=Asia/Brunei
 *     &start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 */
import type { WeatherData } from "../types/usms.js";

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";
// Bandar Seri Begawan, Brunei
const LATITUDE  = 4.9431;
const LONGITUDE = 114.9425;
const TIMEZONE  = "Asia/Brunei";

interface OpenMeteoResponse {
  daily: {
    time: string[];
    apparent_temperature_max: number[];
    apparent_temperature_min: number[];
  };
}

/**
 * Fetch daily feels-like temperature data for the given date range.
 * Returns null on any network or parse error (weather is optional/non-critical).
 */
export async function fetchWeatherData(
  startDate: string, // "YYYY-MM-DD"
  endDate: string    // "YYYY-MM-DD"
): Promise<WeatherData | null> {
  try {
    const params = new URLSearchParams({
      latitude:  String(LATITUDE),
      longitude: String(LONGITUDE),
      daily:     "apparent_temperature_max,apparent_temperature_min",
      timezone:  TIMEZONE,
      start_date: startDate,
      end_date:   endDate,
    });

    const res = await fetch(`${OPEN_METEO_BASE}?${params.toString()}`);
    if (!res.ok) return null;

    const json: OpenMeteoResponse = await res.json();
    const { time, apparent_temperature_max, apparent_temperature_min } = json.daily ?? {};

    if (!time || !apparent_temperature_max || !apparent_temperature_min) {
      return null;
    }

    return {
      dates:         time,
      feelsLikeHigh: apparent_temperature_max,
      feelsLikeLow:  apparent_temperature_min,
    };
  } catch {
    return null;
  }
}
