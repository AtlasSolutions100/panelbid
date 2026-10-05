import {
  pgTable,
  serial,
  text,
  boolean,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Where an exclusion term is matched: the email subject, the sender
// (From header), or either field.
export const exclusionMatchTypeEnum = pgEnum("exclusion_match_type", [
  "subject",
  "sender",
  "either",
]);

/**
 * Email exclusion terms — the pre-filter that stops non-bid emails
 * (invoices, welcome emails, newsletters, …) from becoming jobs.
 */
export const exclusionTermsTable = pgTable("exclusion_terms", {
  id: serial("id").primaryKey(),
  term: text("term").notNull(),
  matchType: exclusionMatchTypeEnum("match_type").notNull().default("either"),
  active: boolean("active").notNull().default(true),
});

export const insertExclusionTermSchema = createInsertSchema(
  exclusionTermsTable,
).omit({ id: true });
export type InsertExclusionTerm = z.infer<typeof insertExclusionTermSchema>;
export type ExclusionTerm = typeof exclusionTermsTable.$inferSelect;
