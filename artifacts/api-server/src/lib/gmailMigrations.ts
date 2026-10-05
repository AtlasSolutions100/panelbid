/**
 * Startup migrations for the gmail_connections table.
 *
 * runGmailSchemaMigration() — idempotent DDL: adds the five OAuth token
 *   columns introduced by the first-party OAuth flow.  Uses
 *   ADD COLUMN IF NOT EXISTS so it is safe to run on every server start
 *   against both fresh and existing databases (dev and production).
 *
 * migrateGmailLegacyRows() — data migration: marks any Replit-connector
 *   rows (no refresh token stored) as tokenStatus="invalid" so they prompt
 *   reconnect instead of silently failing every poll.
 *
 * Both are called at server startup, in order, before polling begins.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db, pool, gmailConnectionsTable } from "@workspace/db";
import { logger } from "./logger";

/**
 * Add the five OAuth token columns to gmail_connections if they don't exist.
 * IF NOT EXISTS makes this fully idempotent — safe on repeated starts.
 */
export async function runGmailSchemaMigration(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE gmail_connections
        ADD COLUMN IF NOT EXISTS refresh_token_enc       TEXT,
        ADD COLUMN IF NOT EXISTS access_token_enc        TEXT,
        ADD COLUMN IF NOT EXISTS access_token_expires_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS granted_scopes          TEXT,
        ADD COLUMN IF NOT EXISTS token_status            TEXT NOT NULL DEFAULT 'active'
    `);
    logger.info("Gmail schema migration: OAuth columns ensured");
  } catch (err) {
    // Surface the error — the server should not start without the columns.
    logger.error({ err }, "Gmail schema migration failed");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Mark any legacy Replit-connector Gmail rows (tokenStatus="active" but no
 * refresh token) as tokenStatus="invalid" so Settings shows a reconnect
 * prompt instead of silently failing every poll cycle.
 */
export async function migrateGmailLegacyRows(): Promise<void> {
  const updated = await db
    .update(gmailConnectionsTable)
    .set({ tokenStatus: "invalid" })
    .where(
      and(
        eq(gmailConnectionsTable.tokenStatus, "active"),
        isNull(gmailConnectionsTable.refreshTokenEnc),
      ),
    )
    .returning({ id: gmailConnectionsTable.id });

  if (updated.length > 0) {
    logger.info(
      { count: updated.length },
      "Gmail: marked legacy connector rows as needing reconnect",
    );
  }
}
