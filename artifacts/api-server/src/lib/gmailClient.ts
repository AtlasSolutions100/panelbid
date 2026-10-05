/**
 * Token-aware Gmail REST client.
 *
 * Calls the Gmail API directly with the OAuth access token stored in the
 * gmail_connections row, refreshing via the refresh token when expired.
 * A module-level promise guards against parallel double-refreshes.
 *
 * On unrecoverable auth errors (revoked/expired refresh token) the
 * connection row is marked tokenStatus="invalid" and callers receive a
 * GmailReconnectRequiredError — polling should pause until reconnect.
 */
import { eq } from "drizzle-orm";
import { db, gmailConnectionsTable, type GmailConnection } from "@workspace/db";
import {
  decryptToken,
  encryptToken,
  refreshAccessToken,
  RefreshTokenInvalidError,
} from "./gmailAuth";
import { logger } from "./logger";

const GMAIL_BASE = "https://gmail.googleapis.com";

export class GmailReconnectRequiredError extends Error {
  constructor(detail: string) {
    super(`Gmail connection needs to be reconnected: ${detail}`);
    this.name = "GmailReconnectRequiredError";
  }
}

// ---------------------------------------------------------------------------
// Types (unchanged from the old connector wrapper)
// ---------------------------------------------------------------------------

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  historyId: string;
}

export interface GmailMessageStub {
  id: string;
  threadId: string;
}

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: {
    attachmentId?: string;
    size?: number;
    data?: string; // base64url
  };
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailMessagePart;
  internalDate?: string; // ms since epoch as string
}

// ---------------------------------------------------------------------------
// Access-token management
// ---------------------------------------------------------------------------

// Refresh the token slightly before its actual expiry.
const EXPIRY_SKEW_MS = 60 * 1000;

// Concurrency guard: parallel callers share one in-flight refresh.
let refreshPromise: Promise<string> | null = null;

async function markConnectionInvalid(connectionId: number, detail: string): Promise<void> {
  logger.warn({ connectionId, detail }, "Gmail refresh token invalid — marking connection for reconnect");
  await db
    .update(gmailConnectionsTable)
    .set({ tokenStatus: "invalid" })
    .where(eq(gmailConnectionsTable.id, connectionId))
    .catch?.(() => {});
}

async function loadConnection(): Promise<GmailConnection> {
  const [connection] = await db.select().from(gmailConnectionsTable).limit(1);
  if (!connection) throw new Error("Gmail is not connected");
  if (connection.tokenStatus === "invalid") {
    throw new GmailReconnectRequiredError("stored tokens are no longer valid");
  }
  if (!connection.refreshTokenEnc) {
    throw new GmailReconnectRequiredError("no refresh token stored");
  }
  return connection;
}

async function doRefresh(connection: GmailConnection): Promise<string> {
  let refreshToken: string;
  try {
    refreshToken = decryptToken(connection.refreshTokenEnc!);
  } catch (err) {
    await markConnectionInvalid(connection.id, "refresh token undecryptable");
    throw new GmailReconnectRequiredError(
      `stored refresh token could not be decrypted: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const tokens = await refreshAccessToken(refreshToken);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    await db
      .update(gmailConnectionsTable)
      .set({
        accessTokenEnc: encryptToken(tokens.access_token),
        accessTokenExpiresAt: expiresAt,
        tokenStatus: "active",
      })
      .where(eq(gmailConnectionsTable.id, connection.id));
    return tokens.access_token;
  } catch (err) {
    if (err instanceof RefreshTokenInvalidError) {
      await markConnectionInvalid(connection.id, err.message);
      throw new GmailReconnectRequiredError(err.message);
    }
    throw err;
  }
}

/** Get a valid access token, refreshing if expired (single-flight). */
export async function getAccessToken(): Promise<string> {
  const connection = await loadConnection();

  const notExpired =
    connection.accessTokenEnc &&
    connection.accessTokenExpiresAt &&
    connection.accessTokenExpiresAt.getTime() - EXPIRY_SKEW_MS > Date.now();

  if (notExpired) {
    try {
      return decryptToken(connection.accessTokenEnc!);
    } catch {
      // fall through to refresh
    }
  }

  if (!refreshPromise) {
    refreshPromise = doRefresh(connection).finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

/**
 * Authenticated Gmail API fetch. Retries once with a forced refresh when the
 * API returns 401 (token revoked server-side before its expiry time).
 */
async function gmailFetch(pathAndQuery: string): Promise<Response> {
  let token = await getAccessToken();
  let resp = await fetch(`${GMAIL_BASE}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (resp.status === 401) {
    const connection = await loadConnection();
    if (!refreshPromise) {
      refreshPromise = doRefresh(connection).finally(() => {
        refreshPromise = null;
      });
    }
    token = await refreshPromise;
    resp = await fetch(`${GMAIL_BASE}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  return resp;
}

async function gmailJson<T>(pathAndQuery: string, what: string): Promise<T> {
  const resp = await gmailFetch(pathAndQuery);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Gmail ${what} request failed (HTTP ${resp.status}): ${body.slice(0, 300)}`);
  }
  return (await resp.json()) as T;
}

// ---------------------------------------------------------------------------
// Gmail API calls
// ---------------------------------------------------------------------------

export async function gmailGetProfile(): Promise<GmailProfile> {
  const profile = await gmailJson<GmailProfile>("/gmail/v1/users/me/profile", "profile");
  if (!profile.emailAddress) {
    throw new Error(
      `Gmail profile response missing emailAddress: ${JSON.stringify(profile).slice(0, 300)}`,
    );
  }
  return profile;
}

export async function gmailListMessages(opts: {
  query: string;
  maxResults?: number;
  pageToken?: string;
}): Promise<{ messages?: GmailMessageStub[]; nextPageToken?: string }> {
  const params = new URLSearchParams({
    q: opts.query,
    maxResults: String(opts.maxResults ?? 50),
  });
  if (opts.pageToken) params.set("pageToken", opts.pageToken);
  return gmailJson(`/gmail/v1/users/me/messages?${params}`, "message list");
}

export async function gmailGetMessage(id: string): Promise<GmailMessage> {
  return gmailJson(`/gmail/v1/users/me/messages/${id}?format=full`, "message");
}

export async function gmailGetAttachment(
  messageId: string,
  attachmentId: string,
): Promise<{ data: string; size: number }> {
  return gmailJson(
    `/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
    "attachment",
  );
}

// ---------------------------------------------------------------------------
// Pure helpers (unchanged)
// ---------------------------------------------------------------------------

/** Decode a base64url string into a Buffer. */
export function decodeBase64Url(b64url: string): Buffer {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

/** Walk a message part tree and collect all PDF parts. */
export function collectPdfParts(part: GmailMessagePart): GmailMessagePart[] {
  const results: GmailMessagePart[] = [];
  if (
    part.mimeType === "application/pdf" ||
    (part.filename && part.filename.toLowerCase().endsWith(".pdf"))
  ) {
    results.push(part);
  }
  if (part.parts) {
    for (const child of part.parts) {
      results.push(...collectPdfParts(child));
    }
  }
  return results;
}

/** Extract plain-text body from a message payload. */
export function extractTextBody(part: GmailMessagePart): string {
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data).toString("utf8");
  }
  if (part.parts) {
    for (const child of part.parts) {
      const text = extractTextBody(child);
      if (text) return text;
    }
  }
  return "";
}

/** Extract header value from a part. */
export function getHeader(part: GmailMessagePart, name: string): string {
  return (
    part.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())
      ?.value ?? ""
  );
}
