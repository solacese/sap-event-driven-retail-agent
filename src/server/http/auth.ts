// ---------------------------------------------------------------------------
// Password gate. DEMO_PASSWORD env, httpOnly signed cookie, 8h expiry.
// All /api/* routes except /api/login require it. Login is rate limited.
// ---------------------------------------------------------------------------
import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE = 'db_session';
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

function secret(): string {
  return process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
}

function sign(value: string): string {
  const mac = createHmac('sha256', secret()).update(value).digest('base64url');
  return `${value}.${mac}`;
}

function verify(signed: string | undefined): boolean {
  if (!signed) return false;
  const idx = signed.lastIndexOf('.');
  if (idx < 0) return false;
  const value = signed.slice(0, idx);
  const expected = sign(value);
  const a = Buffer.from(signed);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;
  // value is an expiry timestamp.
  const exp = Number(value);
  return Number.isFinite(exp) && exp > Date.now();
}

export function demoPassword(): string {
  return process.env.DEMO_PASSWORD || 'solace';
}

export function issueCookie(res: Response) {
  const exp = Date.now() + EIGHT_HOURS_MS;
  const signed = sign(String(exp));
  res.cookie(COOKIE, signed, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: EIGHT_HOURS_MS,
  });
}

export function authDisabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.DISABLE_AUTH ?? '');
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Public-demo mode: no password gate. The frontend's session probe then
  // succeeds and the app renders straight to the dashboard.
  if (authDisabled()) return next();
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[COOKIE];
  if (verify(cookie)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

export function checkPassword(candidate: unknown): boolean {
  if (typeof candidate !== 'string') return false;
  const expected = Buffer.from(demoPassword());
  const got = Buffer.from(candidate);
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}
