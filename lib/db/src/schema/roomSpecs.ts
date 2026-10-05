import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  pgEnum,
  boolean,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { jobsTable } from "./jobs";
import { jobFilesTable } from "./jobFiles";
export const materialCategoryEnum = pgEnum("material_category", [
  "frp",
  "stainless",
  "pvc",
]);

export const extractionConfidenceEnum = pgEnum("extraction_confidence", [
  "high",
  "ambiguous",
]);

export const roomSpecsTable = pgTable("room_specs", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id")
    .notNull()
    .references(() => jobsTable.id, { onDelete: "cascade" }),
  sourceFileId: integer("source_file_id").references(() => jobFilesTable.id, {
    onDelete: "set null",
  }),
  sourcePage: integer("source_page"),
  // All plan pages that contributed data to this (merged) row, e.g. "15, 19".
  sourcePages: text("source_pages"),
  roomName: text("room_name"),
  roomNumber: text("room_number"),
  materialCategory: materialCategoryEnum("material_category"),
  materialHeight: text("material_height"),
  // Ceiling height from the finish schedule's Ceiling Height column, when known.
  // When materialHeight was "to ceiling", it gets resolved to this value.
  ceilingHeight: text("ceiling_height"),
  manufacturer: text("manufacturer"),
  color: text("color"),
  productCode: text("product_code"),
  texture: text("texture"),
  fireRating: text("fire_rating"),
  // True when fire_rating was defaulted to "Class C" because plans showed no rating.
  fireRatingDefaulted: boolean("fire_rating_defaulted").notNull().default(false),
  extractionConfidence: extractionConfidenceEnum("extraction_confidence")
    .notNull()
    .default("high"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertRoomSpecSchema = createInsertSchema(roomSpecsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertRoomSpec = z.infer<typeof insertRoomSpecSchema>;
export type RoomSpecRow = typeof roomSpecsTable.$inferSelect;
