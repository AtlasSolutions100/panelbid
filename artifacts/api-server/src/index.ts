import app from "./app";
import { logger } from "./lib/logger";
import { startGmailPolling } from "./lib/gmailWorker";
import {
  runGmailSchemaMigration,
  migrateGmailLegacyRows,
} from "./lib/gmailMigrations";
import {
  runContractorSchemaMigration,
  seedContractorSources,
  INITIAL_CONTRACTOR_SOURCES,
} from "./lib/contractorMigrations";
import {
  runFilterSchemaMigration,
  seedExclusionTerms,
} from "./lib/filterMigrations";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// ---------------------------------------------------------------------------
// Startup: run database migrations BEFORE accepting requests or polling.
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // 1. Schema migration must succeed before any ORM query that touches the
  //    new OAuth columns.  If it fails, log and exit so the process restarts
  //    rather than serving broken requests against an incomplete schema.
  try {
    await runGmailSchemaMigration();
  } catch (err) {
    logger.fatal({ err }, "Gmail schema migration failed — aborting startup");
    process.exit(1);
  }

  try {
    await runContractorSchemaMigration();
  } catch (err) {
    logger.fatal({ err }, "Contractor schema migration failed — aborting startup");
    process.exit(1);
  }

  // Seed the client-provided contractor list (only when table is empty).
  await seedContractorSources(INITIAL_CONTRACTOR_SOURCES);

  try {
    await runFilterSchemaMigration();
  } catch (err) {
    logger.fatal({ err }, "Filter schema migration failed — aborting startup");
    process.exit(1);
  }
  await seedExclusionTerms();

  // 2. Data migration: mark legacy connector rows as needing reconnect.
  //    Non-fatal — a failure here doesn't block the new OAuth path.
  try {
    await migrateGmailLegacyRows();
  } catch (err) {
    logger.error({ err }, "Gmail legacy-row migration failed — continuing");
  }

  // 3. Bind the HTTP listener only after migrations are complete.
  await new Promise<void>((resolve, reject) => {
    app.listen(port, (err) => {
      if (err) {
        reject(err);
      } else {
        logger.info({ port }, "Server listening");
        resolve();
      }
    });
  });

  // 4. Start Gmail polling after the listener is ready and the schema is safe.
  startGmailPolling();
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal startup error");
  process.exit(1);
});
