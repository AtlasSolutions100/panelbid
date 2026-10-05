import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { jobsTable } from "./jobs";
import { jobFilesTable } from "./jobFiles";
import { keywordCategoryEnum } from "./keywords";

export const planScansTable = pgTable("plan_scans", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id")
    .notNull()
    .references(() => jobsTable.id, { onDelete: "cascade" }),
  fileId: integer("file_id")
    .notNull()
    .references(() => jobFilesTable.id, { onDelete: "cascade" }),
  keywordId: integer("keyword_id").notNull(),
  // Snapshot of the keyword at scan time so results stay readable
  // even if the keyword is later edited or deleted.
  term: text("term").notNull(),
  category: keywordCategoryEnum("category").notNull(),
  pageNumber: integer("page_number").notNull(),
  context: text("context").notNull(),
  scannedAt: timestamp("scanned_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertPlanScanSchema = createInsertSchema(planScansTable).omit({
  id: true,
  scannedAt: true,
});
export type InsertPlanScan = z.infer<typeof insertPlanScanSchema>;
export type PlanScan = typeof planScansTable.$inferSelect;
