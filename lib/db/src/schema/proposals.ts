import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  doublePrecision,
} from "drizzle-orm/pg-core";
import { jobsTable } from "./jobs";

// One bid proposal per job, generated from the job + takeoff and then
// editable field-by-field before PDF export.
export const proposalsTable = pgTable("proposals", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id")
    .notNull()
    .unique()
    .references(() => jobsTable.id, { onDelete: "cascade" }),
  // All editable template fields.
  proposalDate: text("proposal_date").notNull(),
  projectName: text("project_name").notNull(),
  projectAddress: text("project_address").notNull(),
  projectCity: text("project_city").notNull(),
  frp: text("frp").notNull(),
  highImpactWallPanel: text("high_impact_wall_panel").notNull().default("N/A"),
  cornerGuards: text("corner_guards").notNull().default("N/A"),
  stainlessSteel: text("stainless_steel").notNull().default("N/A"),
  addsDeducts: text("adds_deducts").notNull().default("N/A"),
  exclusions: text("exclusions").notNull().default(""),
  notes: text("notes").notNull(),
  priceAmount: doublePrecision("price_amount").notNull().default(0),
  priceInWords: text("price_in_words").notNull().default(""),
  // Generation metadata.
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ProposalRow = typeof proposalsTable.$inferSelect;
