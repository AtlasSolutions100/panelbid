/**
 * Startup migration for the email pre-filter feature. Idempotent DDL —
 * safe to run on every server start against fresh and existing databases.
 *
 * - Creates the exclusion_terms table (+ its match-type enum).
 * - Adds the "filtered" value to the email_outcome enum.
 * - Adds processed_emails.filter_reason.
 * - Seeds default exclusion terms when the table has never been populated.
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";

/** Defaults seeded on first run. Editable/deletable afterwards in Settings. */
const DEFAULT_EXCLUSION_TERMS: Array<{
  term: string;
  matchType: "subject" | "sender" | "either";
}> = [
  { term: "invoice", matchType: "subject" },
  { term: "bill", matchType: "subject" },
  { term: "statement", matchType: "subject" },
  { term: "receipt", matchType: "subject" },
  { term: "welcome", matchType: "subject" },
  { term: "newsletter", matchType: "subject" },
  { term: "billing@", matchType: "sender" },
  { term: "noreply@", matchType: "sender" },
  { term: "invoices@", matchType: "sender" },
  { term: "accounts@", matchType: "sender" },
];

export async function runFilterSchemaMigration(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE exclusion_match_type AS ENUM ('subject', 'sender', 'either');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS exclusion_terms (
        id         SERIAL PRIMARY KEY,
        term       TEXT NOT NULL,
        match_type exclusion_match_type NOT NULL DEFAULT 'either',
        active     BOOLEAN NOT NULL DEFAULT true
      )
    `);
    await client.query(
      "ALTER TYPE email_outcome ADD VALUE IF NOT EXISTS 'filtered'",
    );
    await client.query(
      "ALTER TABLE processed_emails ADD COLUMN IF NOT EXISTS filter_reason TEXT",
    );
    logger.info("Filter schema migration: table, enum value, and column ensured");
  } catch (err) {
    logger.error({ err }, "Filter schema migration failed");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Seed default exclusion terms exactly once (tracked by a marker table, so
 * user deletions of every term are never re-seeded on restart).
 */
export async function seedExclusionTerms(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS exclusion_terms_seed_marker (
        id BOOLEAN PRIMARY KEY DEFAULT true,
        seeded_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query(
      "INSERT INTO exclusion_terms_seed_marker (id) VALUES (true) ON CONFLICT DO NOTHING RETURNING id",
    );
    if (rows.length === 0) return; // already seeded once
    for (const t of DEFAULT_EXCLUSION_TERMS) {
      await client.query(
        "INSERT INTO exclusion_terms (term, match_type) VALUES ($1, $2)",
        [t.term, t.matchType],
      );
    }
    logger.info(
      { count: DEFAULT_EXCLUSION_TERMS.length },
      "Seeded default email exclusion terms",
    );
  } catch (err) {
    logger.error({ err }, "Exclusion terms seed failed");
    throw err;
  } finally {
    client.release();
  }
}
