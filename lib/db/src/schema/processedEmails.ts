import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  pgEnum,
} from "drizzle-orm/pg-core";
import { jobsTable } from "./jobs";
import { contractorSourcesTable } from "./contractorSources";

export const emailOutcomeEnum = pgEnum("email_outcome", [
  "no_plans",
  "job_created",
  "error",
  "filtered",
]);

export const processedEmailsTable = pgTable("processed_emails", {
  id: serial("id").primaryKey(),
  // Unique Gmail message ID — prevents re-processing the same email.
  gmailMessageId: text("gmail_message_id").notNull().unique(),
  sender: text("sender").notNull(),
  subject: text("subject").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  outcome: emailOutcomeEnum("outcome").notNull(),
  // Only set when outcome = job_created.
  jobId: integer("job_id").references(() => jobsTable.id, {
    onDelete: "set null",
  }),
  errorMessage: text("error_message"),
  // Human-readable reason set when outcome = filtered (pre-filter skipped
  // the email before job creation).
  filterReason: text("filter_reason"),
  // Set when the sender matched an active contractor source at processing
  // time. The name is snapshotted so the badge survives later deletes.
  matchedContractorId: integer("matched_contractor_id").references(
    () => contractorSourcesTable.id,
    { onDelete: "set null" },
  ),
  matchedContractorName: text("matched_contractor_name"),
  processedAt: timestamp("processed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ProcessedEmail = typeof processedEmailsTable.$inferSelect;
