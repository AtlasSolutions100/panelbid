import {
  pgTable,
  serial,
  text,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const jobSourceEnum = pgEnum("job_source", ["email", "planhub"]);

export const jobStatusEnum = pgEnum("job_status", [
  "new",
  "analyzing",
  "needs_review",
  "takeoff",
  "proposal_ready",
  "discarded",
]);

export const jobsTable = pgTable("jobs", {
  id: serial("id").primaryKey(),
  jobName: text("job_name").notNull(),
  address: text("address").notNull(),
  city: text("city").notNull(),
  source: jobSourceEnum("source").notNull().default("email"),
  status: jobStatusEnum("status").notNull().default("new"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertJobSchema = createInsertSchema(jobsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobsTable.$inferSelect;
