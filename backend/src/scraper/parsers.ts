/**
 * Cheerio-based DOM helpers shared by all scrapers.
 *
 * This module is intentionally thin — only generic HTML-parsing utilities live
 * here. Report-specific parsing (Excel) is in reports.ts.
 */
import * as cheerio from "cheerio";

export interface ViewStateFields {
  __VIEWSTATE: string;
  __VIEWSTATEGENERATOR: string;
  __EVENTVALIDATION: string;
  /** DevExpress hidden field — echo back on POST to preserve DX state */
  __ASPxHiddenField1?: string;
}

/**
 * Extract ASP.NET WebForms hidden fields from HTML.
 * Returns empty strings for any missing field so callers can safely
 * include them in postbacks without null-checks.
 */
export function extractViewState(html: string): ViewStateFields {
  const $ = cheerio.load(html);
  return {
    __VIEWSTATE:          ($("#__VIEWSTATE").val() as string) ?? "",
    __VIEWSTATEGENERATOR: ($("#__VIEWSTATEGENERATOR").val() as string) ?? "",
    __EVENTVALIDATION:    ($("#__EVENTVALIDATION").val() as string) ?? "",
    __ASPxHiddenField1:   ($("#ASPxHiddenField1").val() as string) ?? "",
  };
}

/**
 * Given a cheerio root and a table selector, return rows as arrays of cell text.
 * Skips the specified number of header rows.
 */
export function parseTable(
  $: cheerio.CheerioAPI,
  tableSelector: string,
  skipHeaderRows = 1
): string[][] {
  const rows: string[][] = [];
  $(tableSelector)
    .find("tr")
    .each((i, row) => {
      if (i < skipHeaderRows) return;
      const cells: string[] = [];
      $(row)
        .find("td, th")
        .each((_, cell) => {
          cells.push($(cell).text().trim());
        });
      if (cells.length > 0) rows.push(cells);
    });
  return rows;
}

/**
 * Load HTML into cheerio with sensible defaults.
 */
export function load(html: string): cheerio.CheerioAPI {
  return cheerio.load(html);
}
