import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env";

export const SESSION_COOKIE_NAME = "vcf_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function sign(payload: string): string {
  return createHmac("sha256", env.sessionSecret ?? "unset").update(payload).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Whether the site is gated at all — unset APP_PASSWORD disables the gate (local dev). */
export function isAuthRequired(): boolean {
  return Boolean(env.appPassword);
}

export function checkPassword(password: string): boolean {
  if (!env.appPassword) return false;
  return safeEqual(password, env.appPassword);
}

export function createSessionCookieValue(): string {
  const expiresAt = String(Date.now() + SESSION_TTL_MS);
  return `${expiresAt}.${sign(expiresAt)}`;
}

export function verifySessionCookieValue(value: string | undefined | null): boolean {
  if (!isAuthRequired()) return true;
  if (!value) return false;
  const [expiresAt, signature] = value.split(".");
  if (!expiresAt || !signature) return false;
  if (Number(expiresAt) < Date.now()) return false;
  return safeEqual(signature, sign(expiresAt));
}
