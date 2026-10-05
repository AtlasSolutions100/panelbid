import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { jobsTable } from "./jobs";
import { jobFilesTable } from "./jobFiles";

/**
 * Pages within uploaded plan PDFs that look like finish schedules —
 * candidates for AI-powered room spec extraction.
 */
export const scheduleCandidatesTable = pgTable(
  "schedule_page_candidates",
  {
    id: serial("id").primaryKey(),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobsTable.id, { onDelete: "cascade" }),
    fileId: integer("file_id")
      .notNull()
      .references(() => jobFilesTable.id, { onDelete: "cascade" }),
    pageNumber: integer("page_number").notNull(),
    // Why this page was flagged (e.g. "finish schedule term", "dense room table")
    reason: text("reason").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("schedule_candidate_file_page").on(t.fileId, t.pageNumber)],
);

export type ScheduleCandidate = typeof scheduleCandidatesTable.$inferSelect;
