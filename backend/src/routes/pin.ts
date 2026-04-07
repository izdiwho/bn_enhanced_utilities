/**
 * PIN-based access control.
 *
 * If APP_PIN is set in the environment, all /api/* routes (except /api/pin/*)
 * require a valid X-App-Pin header. Rate-limited to prevent brute force.
 *
 * If APP_PIN is not set, PIN protection is disabled and everything is open.
 */
import { Router, Request, Response, NextFunction } from "express";
import { randomBytes, timingSafeEqual } from "crypto";

export const pinRouter = Router();

const APP_PIN = process.env.APP_PIN ?? "";
const PIN_ENABLED = APP_PIN.length > 0;

// ─── Rate limiting (per IP, in-memory) ──────────────────────────────────────

interface RateBucket {
  attempts: number;
  resetAt: number;
}

const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 10;               // 10 attempts per window
const rateBuckets = new Map<string, RateBucket>();

// Sweep stale buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(ip);
  }
}, 5 * 60 * 1000).unref();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { attempts: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.attempts++;
  return bucket.attempts > MAX_ATTEMPTS;
}

function getRemainingAttempts(ip: string): number {
  const bucket = rateBuckets.get(ip);
  if (!bucket || Date.now() > bucket.resetAt) return MAX_ATTEMPTS;
  return Math.max(0, MAX_ATTEMPTS - bucket.attempts);
}

// ─── Constant-time PIN comparison ───────────────────────────────────────────

function verifyPin(input: string): boolean {
  if (!PIN_ENABLED) return true;
  const a = Buffer.from(input.padEnd(64, "\0"));
  const b = Buffer.from(APP_PIN.padEnd(64, "\0"));
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─── Verified tokens (in-memory, opaque) ─────────────────────────────────────

const verifiedTokens = new Set<string>();
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function issueToken(): string {
  const token = randomBytes(32).toString("hex");
  verifiedTokens.add(token);
  // Auto-expire
  setTimeout(() => verifiedTokens.delete(token), TOKEN_TTL_MS).unref();
  return token;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/** GET /api/pin/status — tells the frontend whether PIN is required */
pinRouter.get("/status", (_req: Request, res: Response) => {
  return res.json({ required: PIN_ENABLED });
});

/** POST /api/pin/verify — validate a PIN and return a session token */
pinRouter.post("/verify", (req: Request, res: Response) => {
  if (!PIN_ENABLED) {
    return res.json({ ok: true, token: issueToken() });
  }

  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";

  if (isRateLimited(ip)) {
    return res.status(429).json({
      error: "Too many attempts. Try again later.",
      retryAfterSeconds: Math.ceil(RATE_WINDOW_MS / 1000),
    });
  }

  const { pin } = req.body as { pin?: string };
  if (typeof pin !== "string" || !verifyPin(pin)) {
    const remaining = getRemainingAttempts(ip);
    return res.status(401).json({
      error: "Invalid PIN",
      remainingAttempts: remaining,
    });
  }

  const token = issueToken();
  return res.json({ ok: true, token });
});

// ─── Middleware for protecting /api/* routes ──────────────────────────────────

export function pinGuard(req: Request, res: Response, next: NextFunction) {
  // If PIN is not configured, allow everything
  if (!PIN_ENABLED) return next();

  const token = req.headers["x-pin-token"] as string | undefined;
  if (!token || !verifiedTokens.has(token)) {
    return res.status(401).json({ error: "PIN required" });
  }

  return next();
}
