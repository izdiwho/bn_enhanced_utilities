/**
 * Parse meter cards from the SmartMeter Home page.
 *
 * The Home page uses DevExpress ASPxCardView. Each meter appears as a series
 * of single-row tables with labels and values (from live HTML analysis):
 *
 *   Table N:     "Meter No:12345678"
 *   Table N+2:   "Full Name:FULL NAME"
 *   Table N+3:   "Meter Status:ACTIVE"
 *   Table N+4:   "Address:ADDRESS"
 *   Table N+5:   "Kampong:KAMPONG"
 *   Table N+6:   "Mukim:MUKIM"
 *   Table N+7:   "District:DISTRICT"
 *   Table N+8:   "Postcode:POSTCODE"
 *   Table N+9:   "Remaining Unit:1043.186 kWh"
 *   Table N+10:  "Remaining Balance:$65.43"
 *   Table N+11:  "Last Updated:06/04/2026 05:30:00"
 *
 * Typically two meter cards: one electricity (kWh) and one water (m³).
 *
 * Report links in the page encode the meter number as base64:
 *   href="Report/UsageHistory?p=<base64(meterNo)>"
 */
import * as cheerio from "cheerio";
import { load } from "./parsers.js";

export interface Meter {
  meterNo: string;
  meterType: "electricity" | "water";
  status: string;
  fullName: string;
  address: string;
  kampong: string;
  mukim: string;
  district: string;
  postcode: string;
  remainingUnit: number;
  remainingUnitLabel: string; // "kWh" | "m³"
  remainingBalance: number;   // BND
  lastUpdated: string;
  /** Base64-encoded meter number for UsageHistory report (?p=) */
  reportParam: string;
  /** Base64-encoded meter number for TransactionHistory report (?p=) */
  reportParamTransaction: string;
}

function parseNumber(s: string): number {
  const n = parseFloat(s.replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : n;
}

function inferMeterType(unit: string): "electricity" | "water" {
  const u = unit.toLowerCase();
  if (u.includes("kwh")) return "electricity";
  if (u.includes("m³") || u.includes("m3") || u.includes("cubic")) return "water";
  return "electricity";
}

/**
 * Extract label:value pairs from single-row tables on the Home page.
 * Only considers tables with exactly 1 row and 2 cells (label:value pattern),
 * and no script children (to exclude large container tables).
 */
function extractCardFields($: cheerio.CheerioAPI): Array<Record<string, string>> {
  const cards: Array<Record<string, string>> = [];
  const tableTexts: string[] = [];

  $("table").each((_, t) => {
    // Only include simple 2-cell tables without scripts
    const rows = $(t).find("tr").length;
    const cells = $(t).find("td").length;
    const scripts = $(t).find("script").length;
    if (rows === 1 && cells === 2 && scripts === 0) {
      const text = $(t).text().replace(/\s+/g, " ").trim();
      tableTexts.push(text);
    } else {
      tableTexts.push(""); // placeholder to maintain index alignment
    }
  });

  // Find "Meter No:" tables which start each card
  let i = 0;
  while (i < tableTexts.length) {
    if (tableTexts[i].startsWith("Meter No:")) {
      const card: Record<string, string> = {};
      // Parse consecutive label:value tables belonging to this card
      let j = i;
      const cardLabels = [
        "meter no", "full name", "meter status", "address",
        "kampong", "mukim", "district", "postcode",
        "remaining unit", "remaining balance", "last updated",
      ];
      while (j < tableTexts.length && j < i + 20) {
        const t = tableTexts[j];
        const colonIdx = t.indexOf(":");
        if (colonIdx > 0) {
          const label = t.slice(0, colonIdx).trim().toLowerCase();
          const value = t.slice(colonIdx + 1).trim();
          if (cardLabels.some((l) => label === l)) {
            card[label] = value;
          }
        }
        j++;
        // Stop if we hit another "Meter No:" (next card)
        if (j > i + 1 && tableTexts[j]?.startsWith("Meter No:")) break;
      }
      if (card["meter no"]) cards.push(card);
      i = j;
    } else {
      i++;
    }
  }

  return cards;
}

/**
 * Extract report URL parameters from Home page links.
 * Returns map of meterNo → base64 param value.
 */
interface ReportParams {
  usage: Map<string, string>;      // meterNo → p= param for UsageHistory
  transaction: Map<string, string>; // meterNo → p= param for TransactionHistory
}

function extractReportParams($: cheerio.CheerioAPI): ReportParams {
  const usage = new Map<string, string>();
  const transaction = new Map<string, string>();

  function extractFromLinks(selector: string, target: Map<string, string>) {
    $(selector).each((_, el) => {
      const href = $(el).attr("href") ?? "";
      const pMatch = href.match(/[?&]p=([^&]+)/);
      if (pMatch) {
        try {
          const decoded = Buffer.from(
            decodeURIComponent(pMatch[1]),
            "base64"
          ).toString("utf-8");
          if (/^\d+$/.test(decoded)) {
            target.set(decoded, pMatch[1]);
          }
        } catch {
          // ignore decode errors
        }
      }
    });
  }

  extractFromLinks("a[href*='Report/UsageHistory']", usage);
  extractFromLinks("a[href*='Report/TransactionHistory']", transaction);

  return { usage, transaction };
}

/**
 * Parse all meter cards from the SmartMeter Home page HTML.
 */
export function parseHomePage(html: string): Meter[] {
  const $ = load(html);
  const cardFields = extractCardFields($);
  const reportParams = extractReportParams($);

  return cardFields
    .map((card): Meter | null => {
      const meterNo = card["meter no"] ?? "";
      if (!meterNo) return null;

      const unitRaw = card["remaining unit"] ?? "";
      const unitLabel = unitRaw.toLowerCase().includes("m") ? "m³" : "kWh";
      const unitValue = parseNumber(unitRaw);
      const balanceRaw = (card["remaining balance"] ?? "").replace("$", "");

      // Try to parse lastUpdated as ISO
      let lastUpdated = card["last updated"] ?? "";
      if (lastUpdated && lastUpdated.includes("/")) {
        // DD/MM/YYYY HH:MM:SS → ISO
        try {
          const [datePart, timePart] = lastUpdated.split(" ");
          const [d, m, y] = datePart.split("/");
          lastUpdated = `${y}-${m}-${d}${timePart ? "T" + timePart : ""}`;
        } catch {
          // keep original
        }
      }

      return {
        meterNo,
        meterType: inferMeterType(unitLabel),
        status: card["meter status"] ?? "",
        fullName: card["full name"] ?? "",
        address: card["address"] ?? "",
        kampong: card["kampong"] ?? "",
        mukim: card["mukim"] ?? "",
        district: card["district"] ?? "",
        postcode: card["postcode"] ?? "",
        remainingUnit: unitValue,
        remainingUnitLabel: unitLabel,
        remainingBalance: parseNumber(balanceRaw),
        lastUpdated,
        reportParam: reportParams.usage.get(meterNo) ?? Buffer.from(meterNo).toString("base64"),
        reportParamTransaction: reportParams.transaction.get(meterNo) ?? Buffer.from(meterNo).toString("base64"),
      };
    })
    .filter((m): m is Meter => m !== null);
}
