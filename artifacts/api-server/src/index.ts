import app from "./app";
import { logger } from "./lib/logger";
import { readAuthSettings } from "./lib/auth";
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
import { runFileStoreSchemaMigration } from "./lib/fileStoreMigrations";
import { checkPdfToolsAtStartup } from "./lib/pdfTools";

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

  // The table that keeps every plan file's bytes. Without it no plan can be
  // stored or brought back, so the server must not start half-working.
  try {
    await runFileStoreSchemaMigration();
  } catch (err) {
    logger.fatal({ err }, "File store schema migration failed — aborting startup");
    process.exit(1);
  }

  // 2. Data migration: mark legacy connector rows as needing reconnect.
  //    Non-fatal — a failure here doesn't block the new OAuth path.
  try {
    await migrateGmailLegacyRows();
  } catch (err) {
    logger.error({ err }, "Gmail legacy-row migration failed — continuing");
  }

  // Say it loudly when the sign-in is not set up. The server still starts
  // (so the page can tell the owner what is wrong) but the gate in
  // middlewares/apiGate.ts refuses every request. Names only, never values.
  const authSettings = readAuthSettings();
  if (!authSettings.ok) {
    logger.error(
      { missing: authSettings.missing },
      "Sign-in is NOT set up: every request is refused until these settings are added (see SIGNIN-SETUP.md)",
    );
  }

  // The room reader and the price-sheet reader need two PDF programs on the
  // server. Say it once, loudly, when one is missing. The server still
  // starts: the two readers refuse with a sentence until it is there.
  await checkPdfToolsAtStartup().catch((err) => {
    logger.error({ err }, "PDF tools check failed — continuing");
  });

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
