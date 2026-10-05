import { pgTable, integer, timestamp, customType } from "drizzle-orm/pg-core";
import { jobFilesTable } from "./jobFiles";

/**
 * The bytes of a plan file, kept in the database.
 *
 * The server's disk is thrown away whenever the host restarts or publishes,
 * so the copy under uploads/ cannot be the only one. This table is the one
 * that lasts; the disk copy is brought back from it when it is missing
 * (artifacts/api-server/src/lib/planFileStore.ts).
 *
 * The same table is also made at start-up by
 * artifacts/api-server/src/lib/fileStoreMigrations.ts. The two must describe
 * exactly the same table (names included), or a schema compare will offer
 * to change it: edit both together.
 *
 * Never select `data` in a list: it is the whole file.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const jobFileBlobsTable = pgTable("job_file_blobs", {
  fileId: integer("file_id")
    .primaryKey()
    .references(() => jobFilesTable.id, { onDelete: "cascade" }),
  data: bytea("data").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type JobFileBlob = typeof jobFileBlobsTable.$inferSelect;
export type InsertJobFileBlob = typeof jobFileBlobsTable.$inferInsert;
