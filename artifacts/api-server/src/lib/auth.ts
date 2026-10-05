/**
 * Sign-in for the whole app: one company password, one signed cookie.
 *
 * - The password comes from the environment (APP_PASSWORD). It is compared
 *   in constant time, never logged, never sent back.
 * - A signed-in browser holds a cookie that carries only three times (when
 *   the person signed in, when this cookie was written, when it ends) and a
 *   signature. Nothing is stored on the server.
 * - The signing key is made from SESSION_SECRET and APP_PASSWORD together.
 *   Changing the password therefore signs everyone out, and SESSION_SECRET
 *   can stay as it is (the Gmail link is locked with it).
 * - If either setting is missing the app is "not set up" and the gate in
 *   middlewares/apiGate.ts refuses every request.
 *
 * Only Node's own crypto is used. No value from the environment is ever
 * written to a log or a reply; other code gets the NAMES of what is missing.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "panelbid_session";

/** A shorter APP_PASSWORD counts as "not set": it would not be a lock. */
export const MIN_PASSWORD_LENGTH = 12;
/** A shorter SESSION_SECRET counts as "not set": it could be guessed. */
export const MIN_SECRET_LENGTH = 16;

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** A session ends this long after the browser last used the app. */
export const SESSION_IDLE_MS = 7 * DAY;
/** A session never lasts longer than this, however much it is used. */
export const SESSION_MAX_MS = 30 * DAY;
/** While in use, the cookie is written afresh once it is this old. */
export const SESSION_RENEW_AFTER_MS = 60 * MINUTE;
/** A cookie dated a little in the future is fine (clocks differ). */
const CLOCK_SKEW_MS = 5 * MINUTE;

export type AuthSettings =
  | { ok: true; password: string; key: Buffer }
  | { ok: false; missing: string[] };

/**
 * Read the two settings. Called on every request: there is no "it was set
 * when we started" state that could go stale.
 */
export function readAuthSettings(
  env: NodeJS.ProcessEnv = process.env,
): AuthSettings {
  const password = (env.APP_PASSWORD ?? "").trim();
  const secret = env.SESSION_SECRET ?? "";
  const missing: string[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) missing.push("APP_PASSWORD");
  if (secret.trim().length < MIN_SECRET_LENGTH) missing.push("SESSION_SECRET");
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, password, key: sessionKey(secret, password) };
}

/**
 * The key that signs session cookies. It is not the raw SESSION_SECRET
 * (which also signs the Gmail connection's state), so a value signed for
 * one purpose can never pass for the other.
 */
function sessionKey(secret: string, password: string): Buffer {
  return createHmac("sha256", secret)
    .update("panelbid session cookie v1\n")
    .update(password, "utf8")
    .digest();
}

// A new random key each time the server starts; only used to compare.
const compareKey = randomBytes(32);

/**
 * Constant-time comparison. Both sides are hashed first, so neither the
 * length of the real password nor how many leading characters were right
 * shows in how long this takes.
 */
export function passwordMatches(given: string, expected: string): boolean {
  const a = createHmac("sha256", compareKey).update(given, "utf8").digest();
  const b = createHmac("sha256", compareKey).update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export interface Session {
  /** When the person typed the password (ms). */
  start: number;
  /** When this cookie was written (ms). */
  iat: number;
  /** When this cookie stops working (ms). */
  exp: number;
}

function sign(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/**
 * Make a session cookie value. `start` is kept when a cookie is renewed,
 * so the 30-day limit counts from the day the password was typed.
 */
export function issueSession(
  key: Buffer,
  now: number,
  start: number = now,
): { token: string; session: Session } {
  const session: Session = {
    start,
    iat: now,
    exp: Math.min(now + SESSION_IDLE_MS, start + SESSION_MAX_MS),
  };
  const payload = Buffer.from(
    JSON.stringify({ v: 1, s: session.start, i: session.iat, e: session.exp }),
  ).toString("base64url");
  return { token: `${payload}.${sign(key, payload)}`, session };
}

/**
 * Check a cookie value. Returns the session, or null for anything that is
 * not a cookie this server signed with the current settings and that is
 * still in date.
 */
export function readSession(
  key: Buffer,
  token: unknown,
  now: number,
): Session | null {
  if (typeof token !== "string" || token.length === 0 || token.length > 512) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts as [string, string];

  // Compared as written (not decoded), so only the exact signature passes.
  const given = Buffer.from(signature, "utf8");
  const expected = Buffer.from(sign(key, payload), "utf8");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { v, s, i, e } = parsed as Record<string, unknown>;
  if (v !== 1) return null;
  if (![s, i, e].every((n) => typeof n === "number" && Number.isFinite(n))) {
    return null;
  }
  const session: Session = {
    start: s as number,
    iat: i as number,
    exp: e as number,
  };
  if (session.exp <= now) return null;
  if (session.iat > now + CLOCK_SKEW_MS) return null;
  if (session.start > session.iat) return null;
  if (session.exp > session.start + SESSION_MAX_MS) return null;
  return session;
}

/** True when the cookie is old enough to be written afresh. */
export function shouldRenew(session: Session, now: number): boolean {
  return (
    now - session.iat >= SESSION_RENEW_AFTER_MS &&
    now < session.start + SESSION_MAX_MS
  );
}
