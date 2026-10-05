import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import {
  db,
  jobsTable,
  jobFilesTable,
  roomSpecsTable,
  scheduleCandidatesTable,
  type RoomSpecRow,
} from "@workspace/db";
import {
  ExtractSpecsParams,
  ExtractSpecsResponse,
  ListRoomSpecsParams,
  ListRoomSpecsResponse,
  CreateRoomSpecParams,
  CreateRoomSpecBody,
  CreateRoomSpecResponse,
  UpdateRoomSpecParams,
  UpdateRoomSpecBody,
  UpdateRoomSpecResponse,
  DeleteRoomSpecParams,
  ConfirmSpecsParams,
  ConfirmSpecsResponse,
} from "@workspace/api-zod";
import {
  extractSpecsForJob,
  parseSourcePages,
  SPEC_EXTRACT_LOCK_NS,
} from "../lib/specExtractor";
import { isPlanFileError, planFileErrorBody } from "../lib/planFileStore";

const router: IRouter = Router();

function serializeSpec(row: RoomSpecRow & { sourceFileName?: string | null }) {
  return {
    id: row.id,
    jobId: row.jobId,
    sourceFileId: row.sourceFileId,
    sourceFileName: row.sourceFileName ?? null,
    sourcePage: row.sourcePage,
    // Stored as JSON (fileId, page) tuples; serve as a friendly page list.
    sourcePages: (() => {
      const pages = parseSourcePages(row.sourcePages);
      if (pages.length === 0) return row.sourcePages;
      return [...new Set(pages.map((p) => p.page))]
        .sort((a, b) => a - b)
        .join(", ");
    })(),
    roomName: row.roomName,
    roomNumber: row.roomNumber,
    materialCategory: row.materialCategory,
    materialHeight: row.materialHeight,
    ceilingHeight: row.ceilingHeight,
    manufacturer: row.manufacturer,
    color: row.color,
    productCode: row.productCode,
    texture: row.texture,
    fireRating: row.fireRating,
    fireRatingDefaulted: row.fireRatingDefaulted,
    extractionConfidence: row.extractionConfidence,
    createdAt: row.createdAt.toISOString(),
  };
}

async function findJob(jobId: number) {
  const [job] = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));
  return job;
}

// Jobs with an extraction currently in flight — a second concurrent run for
// the same job would race the first and interleave partial results.
const extractionInFlight = new Set<number>();

router.post("/jobs/:jobId/extract-specs", async (req, res): Promise<void> => {
  const params = ExtractSpecsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }
  const job = await findJob(params.data.jobId);
  if (!job) {
    res.status(404).json({ message: "Job not found" });
    return;
  }
  if (extractionInFlight.has(job.id)) {
    res
      .status(409)
      .json({ message: "Spec extraction is already running for this job" });
    return;
  }
  const files = await db
    .select()
    .from(jobFilesTable)
    .where(eq(jobFilesTable.jobId, job.id));

  extractionInFlight.add(job.id);
  try {
    const result = await extractSpecsForJob(job.id, files);
    req.log.info({ jobId: job.id, ...result }, "Spec extraction complete");
    res.json(ExtractSpecsResponse.parse(result));
  } catch (err) {
    // A plan whose file cannot be had: its own status and sentence (gone: 410).
    if (isPlanFileError(err)) {
      req.log.warn({ jobId: job.id, code: err.code }, "Spec extraction: no plan file could be had");
      res.status(err.status).json(planFileErrorBody(err));
      return;
    }
    req.log.error({ err, jobId: job.id }, "Spec extraction failed");
    res.status(500).json({
      message:
        err instanceof Error ? err.message : "Spec extraction failed",
    });
  } finally {
    extractionInFlight.delete(job.id);
  }
});

router.get("/jobs/:jobId/room-specs", async (req, res): Promise<void> => {
  const params = ListRoomSpecsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }
  const rows = await db
    .select({
      spec: roomSpecsTable,
      sourceFileName: jobFilesTable.fileName,
    })
    .from(roomSpecsTable)
    .leftJoin(jobFilesTable, eq(roomSpecsTable.sourceFileId, jobFilesTable.id))
    .where(eq(roomSpecsTable.jobId, params.data.jobId))
    .orderBy(roomSpecsTable.sourcePage, roomSpecsTable.id);

  res.json(
    ListRoomSpecsResponse.parse(
      rows.map((r) => serializeSpec({ ...r.spec, sourceFileName: r.sourceFileName })),
    ),
  );
});

router.post("/jobs/:jobId/room-specs", async (req, res): Promise<void> => {
  const params = CreateRoomSpecParams.safeParse(req.params);
  const body = CreateRoomSpecBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ message: "Invalid input" });
    return;
  }
  const job = await findJob(params.data.jobId);
  if (!job) {
    res.status(404).json({ message: "Job not found" });
    return;
  }
  const [created] = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${SPEC_EXTRACT_LOCK_NS}, ${job.id})`,
    );
    return tx
      .insert(roomSpecsTable)
      .values({
        jobId: job.id,
      roomName: body.data.roomName ?? null,
      roomNumber: body.data.roomNumber ?? null,
      materialCategory: body.data.materialCategory ?? null,
      materialHeight: body.data.materialHeight ?? null,
      ceilingHeight: body.data.ceilingHeight ?? null,
      manufacturer: body.data.manufacturer ?? null,
      color: body.data.color ?? null,
      productCode: body.data.productCode ?? null,
      texture: body.data.texture ?? null,
      fireRating: body.data.fireRating ?? null,
      fireRatingDefaulted: false,
      // Manually added rows are user-authored, treat as high confidence
      // unless the client says otherwise.
        extractionConfidence: body.data.extractionConfidence ?? "high",
      })
      .returning();
  });
  res.status(201).json(CreateRoomSpecResponse.parse(serializeSpec(created!)));
});

router.patch("/room-specs/:specId", async (req, res): Promise<void> => {
  const params = UpdateRoomSpecParams.safeParse(req.params);
  const body = UpdateRoomSpecBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ message: "Invalid input" });
    return;
  }
  const updates: Record<string, unknown> = {};
  for (const key of [
    "roomName",
    "roomNumber",
    "materialCategory",
    "materialHeight",
    "ceilingHeight",
    "manufacturer",
    "color",
    "productCode",
    "texture",
    "fireRating",
    "extractionConfidence",
  ] as const) {
    if (key in (req.body ?? {})) updates[key] = body.data[key] ?? null;
  }
  // Any manual edit to fire rating clears the "defaulted" note.
  if ("fireRating" in updates) updates.fireRatingDefaulted = false;

  const [updated] = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ jobId: roomSpecsTable.jobId })
      .from(roomSpecsTable)
      .where(eq(roomSpecsTable.id, params.data.specId));
    if (!existing) return [];
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${SPEC_EXTRACT_LOCK_NS}, ${existing.jobId})`,
    );
    return tx
      .update(roomSpecsTable)
      .set(updates)
      .where(eq(roomSpecsTable.id, params.data.specId))
      .returning();
  });
  if (!updated) {
    res.status(404).json({ message: "Room spec not found" });
    return;
  }
  const [file] = updated.sourceFileId
    ? await db
        .select({ fileName: jobFilesTable.fileName })
        .from(jobFilesTable)
        .where(eq(jobFilesTable.id, updated.sourceFileId))
    : [];
  res.json(
    UpdateRoomSpecResponse.parse(
      serializeSpec({ ...updated, sourceFileName: file?.fileName ?? null }),
    ),
  );
});

router.delete("/room-specs/:specId", async (req, res): Promise<void> => {
  const params = DeleteRoomSpecParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }
  const deleted = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ jobId: roomSpecsTable.jobId })
      .from(roomSpecsTable)
      .where(eq(roomSpecsTable.id, params.data.specId));
    if (!existing) return [];
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${SPEC_EXTRACT_LOCK_NS}, ${existing.jobId})`,
    );
    return tx
      .delete(roomSpecsTable)
      .where(eq(roomSpecsTable.id, params.data.specId))
      .returning({ id: roomSpecsTable.id });
  });
  if (deleted.length === 0) {
    res.status(404).json({ message: "Room spec not found" });
    return;
  }
  res.status(204).end();
});

router.post("/jobs/:jobId/confirm-specs", async (req, res): Promise<void> => {
  const params = ConfirmSpecsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }
  const [job] = await db
    .update(jobsTable)
    .set({ status: "takeoff", updatedAt: new Date() })
    .where(eq(jobsTable.id, params.data.jobId))
    .returning();
  if (!job) {
    res.status(404).json({ message: "Job not found" });
    return;
  }
  const [{ count }] = (await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobFilesTable)
    .where(eq(jobFilesTable.jobId, job.id))) as [{ count: number }];
  req.log.info({ jobId: job.id }, "Specs confirmed, job moved to takeoff");
  res.json(
    ConfirmSpecsResponse.parse({
      ...job,
      fileCount: count,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    }),
  );
});

export default router;
