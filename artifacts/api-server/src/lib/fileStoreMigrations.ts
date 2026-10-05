/**
 * Start-up migration for keeping plan files in the database. Idempotent DDL:
 * safe to run on every server start against a fresh or an existing database.
 *
 * It makes ONE table, job_file_blobs, and changes nothing else. The same
 * table is described in lib/db/src/schema/jobFileBlobs.ts; the two must
 * agree exactly, down to the name of the foreign key (Drizzle's own name for
 * it), or a schema compare will offer to change the table.
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";

/** Anything that can run one SQL statement (a pool client, or a test's own). */
export interface SqlRunner {
  query(text: string): Promise<unknown>;
}

export const JOB_FILE_BLOBS_DDL = `
  CREATE TABLE IF NOT EXISTS job_file_blobs (
    file_id    INTEGER PRIMARY KEY,
    data       BYTEA NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT job_file_blobs_file_id_job_files_id_fk
      FOREIGN KEY (file_id) REFERENCES job_files(id) ON DELETE CASCADE
  )
`;

/** Make the table if it is not there. Runs on the given connection. */
export async function ensureJobFileBlobsTable(runner: SqlRunner): Promise<void> {
  await runner.query(JOB_FILE_BLOBS_DDL);
}

export async function runFileStoreSchemaMigration(): Promise<void> {
  const client = await pool.connect();
  try {
    await ensureJobFileBlobsTable(client);
    logger.info("File store schema migration: job_file_blobs table ensured");
  } catch (err) {
    logger.error({ err }, "File store schema migration failed");
    throw err;
  } finally {
    client.release();
  }
}
