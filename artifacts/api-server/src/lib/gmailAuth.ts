/**
 * First-party Google OAuth 2.0 for Gmail (read-only scope).
 *
 * - Builds the Google consent-screen URL with an HMAC-signed state param.
 * - Exchanges authorization codes for tokens; refreshes access tokens.
 * - Encrypts tokens at rest (AES-256-GCM, key derived from SESSION_SECRET).
 * - Best-effort revocation on disconnect.
 *
 * Required secrets: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
 * SESSION_SECRET. Optional: GOOGLE_OAUTH_REDIRECT_URL (otherwise derived
 * from the incoming request's forwarded host).
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { Request } from "express";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function getOAuthConfig(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Google OAuth is not configured: set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET secrets.",
    );
  }
  return { clientId, clientSecret };
}

/**
 * Resolve the OAuth redirect URI. Prefers GOOGLE_OAUTH_REDIRECT_URL; falls
 * back to the request's forwarded host (works in the Replit dev preview and
 * behind the deployment proxy).
 */
export function getRedirectUri(req: Request): string {
  const configured = process.env.GOOGLE_OAUTH_REDIRECT_URL;
  if (configured) return configured;
  const proto = (req.headers["x-forwarded-proto"] as string) ?? req.protocol;
  const host = (req.headers["x-forwarded-host"] as string) ?? req.get("host");
  if (!host) throw new Error("Cannot determine host for OAuth redirect URI");
  return `${proto.split(",")[0]!.trim()}://${host.split(",")[0]!.trim()}/api/gmail/oauth/callback`;
}

// ---------------------------------------------------------------------------
// Signed state parameter (CSRF protection — browser/session-bound nonce)
// ---------------------------------------------------------------------------

function getStateKey(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required for OAuth state signing");
  return secret;
}

/** Cookie name that holds the per-flow nonce (HttpOnly, SameSite=Lax). */
export const OAUTH_NONCE_COOKIE = "gmail_oauth_nonce";

/**
 * Generate a random one-time nonce to store in a browser cookie, then create
 * a signed state token that embeds the same nonce. Callers must:
 *   1. Set `OAUTH_NONCE_COOKIE=nonce` as an HttpOnly, SameSite=Lax cookie.
 *   2. Send `state` as the Google OAuth state parameter.
 */
export function createStateWithNonce(): { state: string; nonce: string } {
  const nonce = randomBytes(24).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ nonce, t: Date.now() }),
  ).toString("base64url");
  const sig = createHmac("sha256", getStateKey()).update(payload).digest("base64url");
  return { state: `${payload}.${sig}`, nonce };
}

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Verify the state token:
 * - HMAC signature must be valid.
 * - Token must not be older than STATE_MAX_AGE_MS.
 * - The nonce embedded in state must match the `cookieNonce` from the browser
 *   cookie, binding this callback to the browser that initiated the flow.
 */
export function verifyState(state: string, cookieNonce: string | undefined): boolean {
  if (!cookieNonce) return false;
  const parts = state.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts as [string, string];
  const expected = createHmac("sha256", getStateKey()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      nonce?: string;
      t?: number;
    };
    if (typeof parsed.t !== "number" || Date.now() - parsed.t > STATE_MAX_AGE_MS) return false;
    // Timing-safe compare of the embedded nonce vs the cookie nonce.
    const a2 = Buffer.from(parsed.nonce ?? "");
    const b2 = Buffer.from(cookieNonce);
    return a2.length === b2.length && timingSafeEqual(a2, b2);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Token encryption at rest (AES-256-GCM, key derived from SESSION_SECRET)
// ---------------------------------------------------------------------------

let cachedKey: Buffer | null = null;
function getEncryptionKey(): Buffer {
  if (!cachedKey) {
    cachedKey = scryptSync(getStateKey(), "panelbid-gmail-token-v1", 32);
  }
  return cachedKey;
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${ct.toString("base64url")}.${tag.toString("base64url")}`;
}

export function decryptToken(stored: string): string {
  const [ver, ivB64, ctB64, tagB64] = stored.split(".");
  if (ver !== "v1" || !ivB64 || !ctB64 || !tagB64) {
    throw new Error("Unrecognized encrypted token format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(ivB64, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

// ---------------------------------------------------------------------------
// OAuth flows
// ---------------------------------------------------------------------------

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

export async function exchangeCode(
  code: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const { clientId, clientSecret } = getOAuthConfig();
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok || typeof body.access_token !== "string") {
    throw new Error(
      `Google token exchange failed (HTTP ${resp.status}): ${String(body.error ?? "unknown")} ${String(body.error_description ?? "")}`.trim(),
    );
  }
  return body as unknown as TokenResponse;
}

/** Error thrown when the refresh token itself is invalid → reconnect needed. */
export class RefreshTokenInvalidError extends Error {
  constructor(detail: string) {
    super(`Gmail refresh token invalid: ${detail}`);
    this.name = "RefreshTokenInvalidError";
  }
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<TokenResponse> {
  const { clientId, clientSecret } = getOAuthConfig();
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok || typeof body.access_token !== "string") {
    const err = String(body.error ?? "");
    // invalid_grant → refresh token revoked/expired: user must reconnect.
    if (err === "invalid_grant" || resp.status === 400 || resp.status === 401) {
      throw new RefreshTokenInvalidError(
        `${err || `HTTP ${resp.status}`} ${String(body.error_description ?? "")}`.trim(),
      );
    }
    throw new Error(`Google token refresh failed (HTTP ${resp.status}): ${err}`);
  }
  return body as unknown as TokenResponse;
}

/** Best-effort token revocation with Google. Never throws. */
export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch {
    // best effort — ignore network failures
  }
}
