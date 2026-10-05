/**
 * Startup migration for the contractor-sources feature. Idempotent DDL
 * (CREATE TABLE / ADD COLUMN IF NOT EXISTS) — safe to run on every server
 * start against both fresh and existing databases (dev and production).
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";

export async function runContractorSchemaMigration(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS contractor_sources (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL,
        value      TEXT,
        active     BOOLEAN NOT NULL DEFAULT true,
        notes      TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // Earlier deployments created value as NOT NULL — relax it so name-only
    // seeded entries are allowed. Idempotent.
    await client.query(
      "ALTER TABLE contractor_sources ALTER COLUMN value DROP NOT NULL",
    );
    await client.query(`
      ALTER TABLE processed_emails
        ADD COLUMN IF NOT EXISTS matched_contractor_id INTEGER
          REFERENCES contractor_sources(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS matched_contractor_name TEXT
    `);
    logger.info("Contractor schema migration: table and columns ensured");
  } catch (err) {
    logger.error({ err }, "Contractor schema migration failed");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Seed the client-provided contractor list. Only inserts when the table is
 * empty, so user edits/deletes are never re-created on restart.
 */
export async function seedContractorSources(
  entries: Array<{ name: string; value?: string | null; notes?: string | null }>,
): Promise<void> {
  if (entries.length === 0) return;
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      "SELECT COUNT(*)::int AS count FROM contractor_sources",
    );
    if (rows[0]?.count > 0) return;
    for (const e of entries) {
      await client.query(
        "INSERT INTO contractor_sources (name, value, notes) VALUES ($1, $2, $3)",
        [e.name, e.value ?? null, e.notes ?? null],
      );
    }
    logger.info({ count: entries.length }, "Seeded contractor sources");
  } catch (err) {
    logger.error({ err }, "Contractor source seeding failed — continuing");
  } finally {
    client.release();
  }
}

export { INITIAL_CONTRACTOR_SOURCES } from "./contractorSeedData";
