/**
 * Brunei public holidays and weekend detection.
 *
 * Holidays sourced from official Brunei calendar for 2025–2026.
 * This list should be updated annually.
 */

/** Fixed annual holidays (MM-DD format) */
const FIXED_HOLIDAYS: string[] = [
  "01-01", // New Year's Day
  "02-23", // National Day
  "05-31", // Royal Brunei Armed Forces Day
  "07-15", // Sultan's Birthday
  "12-25", // Christmas Day
];

/**
 * Variable holidays by full date (YYYY-MM-DD).
 * Islamic holidays move each year; update annually.
 */
const VARIABLE_HOLIDAYS_2025: string[] = [
  "2025-01-27", // Chinese New Year
  "2025-01-29", // Islamic New Year
  "2025-02-11", // Maulidur Rasul (Prophet's Birthday) approx
  "2025-03-01", // First day of Ramadan approx
  "2025-03-29", // Nuzul Al-Quran approx
  "2025-03-31", // Hari Raya Aidilfitri approx
  "2025-04-01", // Hari Raya Aidilfitri (Day 2) approx
  "2025-06-07", // Hari Raya Aidiladha approx
  "2026-01-17", // Islamic New Year 2026 approx
  "2026-01-28", // Chinese New Year 2026
  "2026-03-20", // Maulidur Rasul 2026 approx
];

/** Returns true if a given ISO date (YYYY-MM-DD) is a Brunei public holiday. */
export function isPublicHoliday(isoDate: string): boolean {
  const mmdd = isoDate.slice(5); // MM-DD
  if (FIXED_HOLIDAYS.includes(mmdd)) return true;
  if (VARIABLE_HOLIDAYS_2025.includes(isoDate)) return true;
  return false;
}

/** Returns true if a given ISO date falls on a Saturday or Sunday. */
export function isWeekend(isoDate: string): boolean {
  // Parse as local date to avoid UTC offset shifting the day
  const [y, m, d] = isoDate.split("-").map(Number);
  const day = new Date(y, m - 1, d).getDay(); // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6;
}

/** Returns true if a date is a non-working day (weekend OR public holiday). */
export function isNonWorkingDay(isoDate: string): boolean {
  return isWeekend(isoDate) || isPublicHoliday(isoDate);
}

/** Get all public holiday dates as an array of YYYY-MM-DD strings. */
export function getPublicHolidays(): string[] {
  return [...VARIABLE_HOLIDAYS_2025];
}

// ─── School holidays ──────────────────────────────────────────────────────────

/**
 * Brunei school holiday ranges for 2025–2026.
 * Each entry is an inclusive [startDate, endDate] pair (YYYY-MM-DD).
 * Update annually from the Ministry of Education calendar.
 */
const SCHOOL_HOLIDAY_RANGES: [string, string][] = [
  // 2025
  ["2025-01-01", "2025-01-03"], // New Year break
  ["2025-03-15", "2025-03-23"], // Mid-term break 1
  ["2025-05-23", "2025-06-08"], // Mid-year holidays
  ["2025-08-09", "2025-08-17"], // Mid-term break 2
  ["2025-10-25", "2025-11-09"], // Year-end holidays (Term 3)
  ["2025-11-15", "2026-01-04"], // Long year-end break
  // 2026
  ["2026-01-05", "2026-01-06"], // Extended new year
  ["2026-03-14", "2026-03-22"], // Mid-term break 1 (approx)
  ["2026-05-22", "2026-06-07"], // Mid-year holidays (approx)
];

/**
 * Returns true if a given ISO date falls within a Brunei school holiday period.
 * Weekends during school holidays are also considered school holidays here.
 */
export function isSchoolHoliday(isoDate: string): boolean {
  for (const [start, end] of SCHOOL_HOLIDAY_RANGES) {
    if (isoDate >= start && isoDate <= end) return true;
  }
  return false;
}

/**
 * Returns the "day type" for coloring chart bars:
 *  - "holiday"  — public holiday (highest priority)
 *  - "school"   — school holiday
 *  - "weekend"  — Saturday or Sunday
 *  - "normal"   — regular weekday
 */
export type DayType = "holiday" | "school" | "weekend" | "normal";

export function getDayType(isoDate: string): DayType {
  if (isPublicHoliday(isoDate)) return "holiday";
  if (isSchoolHoliday(isoDate)) return "school";
  if (isWeekend(isoDate)) return "weekend";
  return "normal";
}
