/**
 * AI appliance estimator route.
 *
 * POST /api/ai/estimate-baseline
 * Body: { monthlyKwh: number, applianceList?: string[] }
 * Returns: { appliancesJson: object, rawText: string }
 *
 * Compatible with any OpenAI-compatible API (OpenRouter, Ollama, Together AI,
 * Groq, Azure OpenAI, etc). Configure via environment variables:
 *
 *   AI_API_KEY   — API key (also accepts OPENROUTER_API_KEY for backward compat)
 *   AI_API_URL   — Base URL (default: https://openrouter.ai/api/v1)
 *   AI_MODEL     — Model name (also accepts OPENROUTER_MODEL for backward compat)
 *
 * Temperature is fixed at 0 for deterministic structured output.
 * Seed is set to 42 where supported (harmless if provider ignores it).
 */
import { Router, Request, Response } from "express";
import { createHash } from "crypto";
import { getDb } from "../cache.js";
import { getPromptHistory, savePromptHistory, deletePromptHistory } from "../cache.js";

export const aiRouter = Router();

// ─── AI provider config ──────────────────────────────────────────────────────

const DEFAULT_API_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "qwen/qwen3-235b-a22b-2507";

// Support both new (AI_*) and legacy (OPENROUTER_*) env var names
function getAiConfig() {
  const apiKey = process.env.AI_API_KEY || process.env.OPENROUTER_API_KEY || "";
  const baseUrl = (process.env.AI_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
  const model = process.env.AI_MODEL || process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const isOpenRouter = baseUrl.includes("openrouter.ai");
  return { apiKey, baseUrl, model, isOpenRouter };
}

// ─── Prompt history endpoints ────────────────────────────────────────────────

aiRouter.get("/prompt-history", (_req: Request, res: Response) => {
  return res.json({ history: getPromptHistory() });
});

aiRouter.delete("/prompt-history/:id", (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  deletePromptHistory(id);
  return res.json({ ok: true });
});

// ─── AI response cache (SQLite) ──────────────────────────────────────────────

function ensureAiCacheTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS ai_estimate_cache (
      prompt_hash TEXT PRIMARY KEY,
      response_json TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      cached_at INTEGER NOT NULL
    )
  `);
}

let aiCacheReady = false;

function getCachedEstimate(promptHash: string): { appliancesJson: unknown; rawText: string } | null {
  if (!aiCacheReady) { ensureAiCacheTable(); aiCacheReady = true; }
  const row = getDb()
    .prepare("SELECT response_json, raw_text FROM ai_estimate_cache WHERE prompt_hash = ?")
    .get(promptHash) as { response_json: string; raw_text: string } | undefined;
  if (!row) return null;
  try {
    return { appliancesJson: JSON.parse(row.response_json), rawText: row.raw_text };
  } catch {
    return null;
  }
}

function setCachedEstimate(promptHash: string, appliancesJson: unknown, rawText: string): void {
  if (!aiCacheReady) { ensureAiCacheTable(); aiCacheReady = true; }
  getDb()
    .prepare("INSERT OR REPLACE INTO ai_estimate_cache (prompt_hash, response_json, raw_text, cached_at) VALUES (?, ?, ?, ?)")
    .run(promptHash, JSON.stringify(appliancesJson), rawText, Date.now());
}

aiRouter.post("/estimate-baseline", async (req: Request, res: Response) => {
  const { apiKey, baseUrl, model, isOpenRouter } = getAiConfig();
  if (!apiKey) {
    return res.status(503).json({ error: "AI service not configured (set AI_API_KEY or OPENROUTER_API_KEY)" });
  }

  const { monthlyKwh, applianceList } = req.body as {
    monthlyKwh?: unknown;
    applianceList?: unknown;
  };

  if (typeof monthlyKwh !== "number" || monthlyKwh < 0 || monthlyKwh > 100000) {
    return res.status(400).json({ error: "monthlyKwh must be between 0 and 100000" });
  }

  // Sanitize applianceList: must be strings, bounded length, no injection chars
  const sanitizedAppliances: string[] = Array.isArray(applianceList)
    ? (applianceList as unknown[])
        .filter((item): item is string => typeof item === "string" && item.length > 0)
        .slice(0, 20)
        .map((s) => s.replace(/[\n\r"\\]/g, " ").substring(0, 100).trim())
        .filter((s) => s.length > 0)
    : [];

  const applianceHint =
    sanitizedAppliances.length > 0
      ? `The user has mentioned these appliances: ${sanitizedAppliances.join(", ")}.`
      : "No specific appliances mentioned.";

  const prompt = `
You are an energy analyst. A household in Brunei uses approximately ${monthlyKwh} kWh per month.
${applianceHint}

Estimate the most likely household appliance breakdown in JSON format.
For each appliance, provide a realistic min-max range for kWh per month.
Respond ONLY with a JSON object like:
{
  "appliances": [
    { "name": "Air conditioner", "estimatedKwhPerMonthMin": 80, "estimatedKwhPerMonthMax": 160, "percentOfTotal": 35 },
    ...
  ],
  "notes": "brief explanation"
}
`.trim();

  // Cache key: hash of the full prompt (deterministic for same inputs)
  const promptHash = createHash("sha256").update(prompt).digest("hex");

  // Check cache first — same appliance list + kWh always returns same result
  const cached = getCachedEstimate(promptHash);
  if (cached) {
    // Still save to prompt history (may be first time this prompt is used since history feature)
    if (sanitizedAppliances.length > 0) {
      savePromptHistory(sanitizedAppliances.join(", ").substring(0, 500));
    }
    return res.json({ ...cached, fromCache: true });
  }

  try {
    // Build headers — OpenRouter-specific headers only sent to OpenRouter
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    if (isOpenRouter) {
      headers["HTTP-Referer"] = "https://github.com/izdiwho/bn_enhanced_utilities";
      headers["X-Title"] = "Enhanced Utilities Tracker";
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,    // deterministic — structured JSON extraction, not creative
        seed: 42,           // reinforces determinism (ignored by providers that don't support it)
        max_tokens: 1024,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("[ai/estimate-baseline] OpenRouter error:", response.status, errText);
      return res.status(502).json({ error: "AI service request failed" });
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawText = data.choices?.[0]?.message?.content ?? "";

    // Extract JSON block safely (no greedy regex — use indexOf instead)
    let appliancesJson: unknown = null;
    const startIdx = rawText.indexOf("{");
    const endIdx = rawText.lastIndexOf("}");
    if (startIdx !== -1 && endIdx > startIdx) {
      try {
        appliancesJson = JSON.parse(rawText.slice(startIdx, endIdx + 1));
      } catch {
        // Return raw text anyway; client handles graceful degradation
      }
    }

    // Cache the result so identical inputs always return the same output
    if (appliancesJson) {
      setCachedEstimate(promptHash, appliancesJson, rawText);
      // Save the user's appliance description to prompt history
      if (sanitizedAppliances.length > 0) {
        savePromptHistory(sanitizedAppliances.join(", ").substring(0, 500));
      }
    }

    return res.json({ appliancesJson, rawText });
  } catch (err) {
    console.error("[ai/estimate-baseline] Unexpected error:", (err as Error).message);
    return res.status(500).json({ error: "Internal server error" });
  }
});
