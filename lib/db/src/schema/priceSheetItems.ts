import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  doublePrecision,
} from "drizzle-orm/pg-core";
import { jobFilesTable } from "./jobFiles";

// One extraction status row per job file (a manufacturer price sheet PDF).
// Tracks the background extraction run so the UI can poll for progress.
export const priceSheetExtractionsTable = pgTable("price_sheet_extractions", {
  id: serial("id").primaryKey(),
  jobFileId: integer("job_file_id")
    .notNull()
    .unique()
    .references(() => jobFilesTable.id, { onDelete: "cascade" }),
  // "running" | "completed" | "failed"
  status: text("status").notNull(),
  error: text("error"),
  itemCount: integer("item_count").notNull().default(0),
  pagesProcessed: integer("pages_processed").notNull().default(0),
  pagesFailed: integer("pages_failed").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// Structured line items extracted from a manufacturer price sheet.
// Unknown fields are stored as null — never guessed.
export const priceSheetItemsTable = pgTable("price_sheet_items", {
  id: serial("id").primaryKey(),
  jobFileId: integer("job_file_id")
    .notNull()
    .references(() => jobFilesTable.id, { onDelete: "cascade" }),
  productDescription: text("product_description"),
  // Raw sheet size text as printed, e.g. "4x8", "4' x 10'".
  sheetSize: text("sheet_size"),
  pricePerSheet: doublePrecision("price_per_sheet"),
  pricePerSqft: doublePrecision("price_per_sqft"),
  productCode: text("product_code"),
  // "high" | "ambiguous"
  extractionConfidence: text("extraction_confidence").notNull().default("high"),
  sourcePage: integer("source_page").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PriceSheetExtractionRow =
  typeof priceSheetExtractionsTable.$inferSelect;
export type PriceSheetItemRow = typeof priceSheetItemsTable.$inferSelect;
export type InsertPriceSheetItem = typeof priceSheetItemsTable.$inferInsert;
