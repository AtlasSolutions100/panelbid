/**
 * Gmail integration routes (first-party Google OAuth).
 *
 * GET  /gmail/status          — connection status + metadata (never tokens)
 * GET  /gmail/connect         — start OAuth: redirect to Google consent screen
 * GET  /gmail/oauth/callback  — exchange code, store tokens, redirect to Settings
 * POST /gmail/disconnect      — revoke tokens (best effort) and delete connection
 * POST /gmail/poll            — trigger an immediate poll (manual)
 * GET  /gmail/activity        — recent processed-email log (newest first)
 */
import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, gmailConnectionsTable, processedEmailsTable } from "@workspace/db";
import {
  decryptToken,
  encryptToken,
  exchangeCode,
  getOAuthConfig,
  getRedirectUri,
  GMAIL_SCOPE,
  OAUTH_NONCE_COOKIE,
  createStateWithNonce,
  revokeToken,
  verifyState,
} from "../lib/gmailAuth";
import { pollOnce, reprocessMessageBypassingFilters } from "../lib/gmailWorker";

const router: IRouter = Router();

/** Where to send the browser after the OAuth callback. */
function settingsUrl(result: string): string {
  return `/settings?gmail=${encodeURIComponent(result)}`;
}

// ---------------------------------------------------------------------------
// GET /gmail/status
// ---------------------------------------------------------------------------
router.get("/gmail/status", async (_req, res): Promise<void> => {
  const [connection] = await db.select().from(gmailConnectionsTable).limit(1);
  if (!connection) {
    res.json({
      connected: false,
      email: null,
      isEnabled: false,
      lastPolledAt: null,
      connectedAt: null,
      needsReconnect: false,
    });
    return;
  }
  res.json({
    connected: true,
    email: connection.connectedEmail,
    isEnabled: connection.isEnabled,
    lastPolledAt: connection.lastPolledAt?.toISOString() ?? null,
    connectedAt: connection.connectedAt.toISOString(),
    needsReconnect: connection.tokenStatus === "invalid",
  });
});

// ---------------------------------------------------------------------------
// GET /gmail/connect — start the OAuth flow (full-page redirect)
// ---------------------------------------------------------------------------
router.get("/gmail/connect", async (req, res): Promise<void> => {
  try {
    getOAuthConfig(); // fail fast with a clear message if not configured
  } catch (err) {
    req.log.error({ err }, "Gmail connect: OAuth not configured");
    res.redirect(settingsUrl("error:not_configured"));
    return;
  }

  // If a healthy connection exists, don't start a new flow — the user must
  // disconnect first. A tokenStatus="invalid" connection may reconnect.
  const [existing] = await db.select().from(gmailConnectionsTable).limit(1);
  if (existing && existing.tokenStatus !== "invalid") {
    res.redirect(settingsUrl("error:already_connected"));
    return;
  }

  try {
    const redirectUri = getRedirectUri(req);
    const { clientId } = getOAuthConfig();
    const { state, nonce } = createStateWithNonce();

    // Store the nonce in an HttpOnly, SameSite=Lax cookie. This binds the
    // callback to the browser that started the flow (CSRF protection).
    const isSecure = req.secure || (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() === "https";
    res.cookie(OAUTH_NONCE_COOKIE, nonce, {
      httpOnly: true,
      sameSite: "lax",
      secure: isSecure,
      maxAge: 10 * 60 * 1000, // 10 min — matches STATE_MAX_AGE_MS
      path: "/api/gmail/oauth",
    });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GMAIL_SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  } catch (err) {
    req.log.error({ err }, "Gmail connect: failed to build auth URL");
    res.redirect(settingsUrl("error:start_failed"));
  }
});

// ---------------------------------------------------------------------------
// GET /gmail/oauth/callback
// ---------------------------------------------------------------------------
router.get("/gmail/oauth/callback", async (req, res): Promise<void> => {
  const { code, state, error } = req.query as Record<string, string | undefined>;

  if (error) {
    req.log.info({ error }, "Gmail OAuth: user denied or Google error");
    res.redirect(settingsUrl(error === "access_denied" ? "error:denied" : "error:google"));
    return;
  }
  // Read the nonce cookie, then immediately clear it (one-time use).
  const cookieNonce = req.cookies?.[OAUTH_NONCE_COOKIE] as string | undefined;
  res.clearCookie(OAUTH_NONCE_COOKIE, { path: "/api/gmail/oauth" });

  if (!code || !state || !verifyState(state, cookieNonce)) {
    req.log.warn("Gmail OAuth: missing code or invalid/replayed state");
    res.redirect(settingsUrl("error:invalid_state"));
    return;
  }

  try {
    const tokens = await exchangeCode(code, getRedirectUri(req));

    if (tokens.scope && !tokens.scope.includes(GMAIL_SCOPE)) {
      res.redirect(settingsUrl("error:scope_denied"));
      return;
    }
    if (!tokens.refresh_token) {
      // Should not happen with prompt=consent + access_type=offline.
      res.redirect(settingsUrl("error:no_refresh_token"));
      return;
    }

    // Fetch the profile email directly with the fresh access token.
    const profileResp = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    );
    if (!profileResp.ok) {
      const body = await profileResp.text().catch(() => "");
      req.log.error(
        { status: profileResp.status, body: body.slice(0, 500) },
        "Gmail OAuth: profile request rejected by Google",
      );
      // 403 with SERVICE_DISABLED/accessNotConfigured → the Gmail API is not
      // enabled in the Google Cloud project that owns this OAuth client.
      if (
        profileResp.status === 403 &&
        (body.includes("SERVICE_DISABLED") || body.includes("accessNotConfigured"))
      ) {
        res.redirect(settingsUrl("error:gmail_api_disabled"));
        return;
      }
      throw new Error(
        `Gmail profile request failed (HTTP ${profileResp.status}): ${body.slice(0, 300)}`,
      );
    }
    const profile = (await profileResp.json()) as { emailAddress?: string };
    if (!profile.emailAddress) throw new Error("Gmail profile missing emailAddress");

    const tokenFields = {
      connectedEmail: profile.emailAddress,
      isEnabled: true,
      refreshTokenEnc: encryptToken(tokens.refresh_token),
      accessTokenEnc: encryptToken(tokens.access_token),
      accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      grantedScopes: tokens.scope ?? GMAIL_SCOPE,
      tokenStatus: "active",
    };

    // Reconnect path: update the existing (invalid) row. Fresh connect:
    // insert, relying on the DB singleton key against concurrent connects.
    const [existing] = await db.select().from(gmailConnectionsTable).limit(1);
    if (existing) {
      if (existing.tokenStatus !== "invalid") {
        res.redirect(settingsUrl("error:already_connected"));
        return;
      }
      await db
        .update(gmailConnectionsTable)
        .set(tokenFields)
        .where(eq(gmailConnectionsTable.id, existing.id));
    } else {
      const inserted = await db
        .insert(gmailConnectionsTable)
        .values(tokenFields)
        .onConflictDoNothing({ target: gmailConnectionsTable.singletonKey })
        .returning({ id: gmailConnectionsTable.id });
      if (inserted.length === 0) {
        res.redirect(settingsUrl("error:already_connected"));
        return;
      }
    }

    req.log.info({ email: profile.emailAddress }, "Gmail connected via OAuth");
    res.redirect(settingsUrl("connected"));
  } catch (err) {
    req.log.error({ err }, "Gmail OAuth callback failed");
    res.redirect(settingsUrl("error:exchange_failed"));
  }
});

// ---------------------------------------------------------------------------
// POST /gmail/disconnect
// ---------------------------------------------------------------------------
router.post("/gmail/disconnect", async (req, res): Promise<void> => {
  const [connection] = await db.select().from(gmailConnectionsTable).limit(1);

  // Best-effort revocation with Google before deleting stored tokens.
  if (connection?.refreshTokenEnc) {
    try {
      await revokeToken(decryptToken(connection.refreshTokenEnc));
    } catch (err) {
      req.log.warn({ err }, "Gmail disconnect: token revocation failed (continuing)");
    }
  }

  await db.delete(gmailConnectionsTable);
  req.log.info("Gmail connection removed");
  res.json({ connected: false });
});

// ---------------------------------------------------------------------------
// POST /gmail/poll  (manual trigger — useful for testing)
// ---------------------------------------------------------------------------
router.post("/gmail/poll", async (req, res): Promise<void> => {
  const [connection] = await db.select().from(gmailConnectionsTable).limit(1);
  if (!connection || !connection.isEnabled) {
    res.status(400).json({ message: "Gmail is not connected" });
    return;
  }
  if (connection.tokenStatus === "invalid") {
    res.status(400).json({ message: "Gmail connection needs to be reconnected" });
    return;
  }
  // Fire-and-forget so the HTTP response returns immediately.
  pollOnce().catch((err) => req.log.error({ err }, "Manual Gmail poll failed"));
  res.json({ message: "Poll triggered" });
});

// ---------------------------------------------------------------------------
// GET /gmail/activity
// ---------------------------------------------------------------------------
router.get("/gmail/activity", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(processedEmailsTable)
    .orderBy(desc(processedEmailsTable.processedAt))
    .limit(50);

  res.json(
    rows.map((r) => ({
      id: r.id,
      gmailMessageId: r.gmailMessageId,
      sender: r.sender,
      subject: r.subject,
      receivedAt: r.receivedAt.toISOString(),
      outcome: r.outcome,
      jobId: r.jobId ?? null,
      errorMessage: r.errorMessage ?? null,
      filterReason: r.filterReason ?? null,
      matchedContractorName: r.matchedContractorName ?? null,
      processedAt: r.processedAt.toISOString(),
    })),
  );
});

// ---------------------------------------------------------------------------
// POST /gmail/activity/:processedEmailId/process-anyway
// Override a filtered email — reprocess it with the pre-filters bypassed.
// ---------------------------------------------------------------------------
router.post(
  "/gmail/activity/:processedEmailId/process-anyway",
  async (req, res): Promise<void> => {
    const id = Number(req.params.processedEmailId);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ message: "Invalid processed email id" });
      return;
    }

    const [entry] = await db
      .select()
      .from(processedEmailsTable)
      .where(eq(processedEmailsTable.id, id))
      .limit(1);
    if (!entry) {
      res.status(404).json({ message: "Processed email not found" });
      return;
    }
    if (entry.outcome !== "filtered") {
      res.status(400).json({ message: "Only filtered emails can be reprocessed" });
      return;
    }

    const [connection] = await db.select().from(gmailConnectionsTable).limit(1);
    if (!connection || !connection.isEnabled || connection.tokenStatus === "invalid") {
      res.status(400).json({ message: "Gmail is not connected" });
      return;
    }

    try {
      await reprocessMessageBypassingFilters(entry.gmailMessageId);
    } catch (err) {
      req.log.error({ err, id }, "Process-anyway reprocess failed");
      res.status(500).json({ message: "Reprocessing failed" });
      return;
    }

    const [updated] = await db
      .select()
      .from(processedEmailsTable)
      .where(eq(processedEmailsTable.id, id))
      .limit(1);
    const r = updated ?? entry;
    res.json({
      id: r.id,
      gmailMessageId: r.gmailMessageId,
      sender: r.sender,
      subject: r.subject,
      receivedAt: r.receivedAt.toISOString(),
      outcome: r.outcome,
      jobId: r.jobId ?? null,
      errorMessage: r.errorMessage ?? null,
      filterReason: r.filterReason ?? null,
      matchedContractorName: r.matchedContractorName ?? null,
      processedAt: r.processedAt.toISOString(),
    });
  },
);

export default router;
