/**
 * Auth / config routes.
 *
 * GET /api/config  — returns meter list + feature flags (no credentials needed).
 *
 * The old POST /api/login and POST /api/logout endpoints are removed.
 * Authentication is handled server-side via USMS_IC + USMS_PASSWORD env vars (set in .env).
 */
import { Router, Request, Response } from "express";
import { ensureSession } from "../session.js";

export const authRouter = Router();

authRouter.get("/config", async (_req: Request, res: Response) => {
  try {
    const session = await ensureSession();
    return res.json({
      meters: session.meters,
      features: {
        ai: Boolean(process.env.OPENROUTER_API_KEY),
      },
    });
  } catch (err) {
    console.error("[config] Failed to get session:", (err as Error).message);
    return res.status(503).json({
      error: "Could not connect to the SmartMeter portal. Check USMS_IC and USMS_PASSWORD in .env.",
    });
  }
});
