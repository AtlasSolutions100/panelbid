import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  jsonb,
  doublePrecision,
} from "drizzle-orm/pg-core";
import { jobsTable } from "./jobs";
import { jobFilesTable } from "./jobFiles";

// Room measurement rows and sheet pricing rows are stored as JSON documents:
// they are always read/written as a whole sheet, never queried individually.
export interface TakeoffRoomRowJson {
  roomName: string | null;
  roomNumber: string | null;
  // Wall lengths as entered, e.g. "8 + 8 + 8 + 8" (displayed verbatim).
  wallLengths: string;
  materialHeight: string | null;
  manufacturer: string | null;
  color: string | null;
  productCode: string | null;
  fireRating: string | null;
  moldingType: "aluminum" | "pvc" | null;
  // Ceiling height, used (and marked "assumed to ceiling") when the room has
  // no panel height. Absent on rows saved before update 1.
  ceilingHeight?: string | null;
}

export interface TakeoffSheetRowJson {
  sheetsNeeded: number;
  sheetSize: "4x4" | "4x8" | "4x10" | "4x12";
  // 0 = no price typed (shown as "not priced").
  pricePerSheet: number;
  // "suggested": the count follows the wall lengths. "typed" or absent: the
  // person's own count.
  sheetsSource?: "suggested" | "typed";
  // Typed molding count for this row's molding length; null/absent = not typed.
  moldingCount?: number | null;
}

export const takeoffsTable = pgTable("takeoffs", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id")
    .notNull()
    .unique()
    .references(() => jobsTable.id, { onDelete: "cascade" }),
  roomRows: jsonb("room_rows").$type<TakeoffRoomRowJson[]>().notNull().default([]),
  sheetRows: jsonb("sheet_rows").$type<TakeoffSheetRowJson[]>().notNull().default([]),
  // Manufacturer price sheet uploaded/selected for reference.
  priceSheetFileId: integer("price_sheet_file_id").references(
    () => jobFilesTable.id,
    { onDelete: "set null" },
  ),
  // Cost breakdown inputs.
  laborRate: doublePrecision("labor_rate").notNull().default(0),
  laborDays: doublePrecision("labor_days").notNull().default(0),
  laborHoursPerDay: doublePrecision("labor_hours_per_day").notNull().default(0),
  travelMiles: doublePrecision("travel_miles").notNull().default(0),
  hotelNights: doublePrecision("hotel_nights").notNull().default(0),
  freight: doublePrecision("freight").notNull().default(0),
  // Profit override; null means "use the auto-calculated profit".
  profitOverride: doublePrecision("profit_override"),
  // Computed total at last save (for listing/reporting without recomputing).
  totalPrice: doublePrecision("total_price").notNull().default(0),
  notes: text("notes"),
  // Panel thickness (e.g. ".090") used by the proposal FRP sentence.
  thickness: text("thickness"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type TakeoffRow = typeof takeoffsTable.$inferSelect;
