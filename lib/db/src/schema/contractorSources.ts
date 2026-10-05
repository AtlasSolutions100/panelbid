import {
  pgTable,
  serial,
  text,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Known GC / contractor bid sources. Each entry is either an exact email
 * address (contains "@") or a domain (e.g. "turnerconstruction.com").
 * Matching is case-insensitive and subdomain-insensitive for domains.
 * Purely a signal — never gates email processing.
 */
export const contractorSourcesTable = pgTable("contractor_sources", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  // Domain (example.com) or exact email address (someone@example.com).
  // Nullable: seeded entries may have a name only until a domain is known;
  // such entries never match incoming email.
  value: text("value"),
  active: boolean("active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ContractorSource = typeof contractorSourcesTable.$inferSelect;
