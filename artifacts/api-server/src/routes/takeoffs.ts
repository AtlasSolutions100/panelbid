import { Router, type IRouter } from "express";
import { eq, asc } from "drizzle-orm";
import {
  db,
  jobsTable,
  roomSpecsTable,
  takeoffsTable,
  type TakeoffRow,
} from "@workspace/db";
import {
  GetTakeoffParams,
  GetTakeoffResponse,
  SaveTakeoffParams,
  SaveTakeoffBody,
  SaveTakeoffResponse,
} from "@workspace/api-zod";
import {
  draftRoomRows,
  refreshSuggestedRows,
  sameJson,
  savedTotalPrice,
  tidyMoldingCounts,
} from "../lib/takeoffRules";

const router: IRouter = Router();

function serializeTakeoff(row: TakeoffRow) {
  return {
    jobId: row.jobId,
    saved: true,
    roomRows: row.roomRows,
    sheetRows: row.sheetRows,
    priceSheetFileId: row.priceSheetFileId,
    laborRate: row.laborRate,
    laborDays: row.laborDays,
    laborHoursPerDay: row.laborHoursPerDay,
    travelMiles: row.travelMiles,
    hotelNights: row.hotelNights,
    freight: row.freight,
    profitOverride: row.profitOverride,
    totalPrice: row.totalPrice,
    notes: row.notes,
    thickness: row.thickness,
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get("/jobs/:jobId/takeoff", async (req, res): Promise<void> => {
  const params = GetTakeoffParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }
  const jobId = params.data.jobId;
  const [job] = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));
  if (!job) {
    res.status(404).json({ message: "Job not found" });
    return;
  }

  const [existing] = await db
    .select()
    .from(takeoffsTable)
    .where(eq(takeoffsTable.jobId, jobId));
  if (existing) {
    res.json(GetTakeoffResponse.parse(serializeTakeoff(existing)));
    return;
  }

  // No saved takeoff yet — return a draft pre-populated from room specs.
  const specs = await db
    .select()
    .from(roomSpecsTable)
    .where(eq(roomSpecsTable.jobId, jobId))
    .orderBy(asc(roomSpecsTable.id));

  const draft = {
    jobId,
    saved: false,
    // The ceiling height rides beside the panel height and is never copied
    // into it: a room with no panel height reads "assumed to ceiling".
    roomRows: draftRoomRows(specs),
    sheetRows: [],
    priceSheetFileId: null,
    laborRate: 0,
    laborDays: 0,
    laborHoursPerDay: 0,
    travelMiles: 0,
    hotelNights: 0,
    freight: 0,
    profitOverride: null,
    totalPrice: 0,
    notes: null,
    thickness: null,
    updatedAt: null,
  };
  res.json(GetTakeoffResponse.parse(draft));
});

router.put("/jobs/:jobId/takeoff", async (req, res): Promise<void> => {
  const params = SaveTakeoffParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }
  const body = SaveTakeoffBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: body.error.message });
    return;
  }
  const jobId = params.data.jobId;
  // Suggested sheet rows are brought up to date with the rooms before they
  // are stored. Rows the person typed are stored exactly as sent.
  const sheetRows = tidyMoldingCounts(
    refreshSuggestedRows(body.data.roomRows, body.data.sheetRows),
  );
  const [job] = await db
    .select({ id: jobsTable.id, status: jobsTable.status })
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));
  if (!job) {
    res.status(404).json({ message: "Job not found" });
    return;
  }

  const values = {
    jobId,
    roomRows: body.data.roomRows,
    sheetRows,
    priceSheetFileId: body.data.priceSheetFileId ?? null,
    laborRate: body.data.laborRate,
    laborDays: body.data.laborDays,
    laborHoursPerDay: body.data.laborHoursPerDay,
    travelMiles: body.data.travelMiles,
    hotelNights: body.data.hotelNights,
    freight: body.data.freight,
    profitOverride: body.data.profitOverride ?? null,
    // The server works the total out itself from the shared rules; the figure
    // the browser sends is not trusted.
    // Stored as 0 ("no price") unless the takeoff is fully priced.
    totalPrice: savedTotalPrice({
      sheetRows,
      laborRate: body.data.laborRate,
      laborDays: body.data.laborDays,
      laborHoursPerDay: body.data.laborHoursPerDay,
      travelMiles: body.data.travelMiles,
      hotelNights: body.data.hotelNights,
      freight: body.data.freight,
      profitOverride: body.data.profitOverride ?? null,
    }),
    notes: body.data.notes ?? null,
    thickness: body.data.thickness ?? null,
    updatedAt: new Date(),
  };

  // A save that changes nothing leaves the stored takeoff, and its saved
  // time, alone. Otherwise pressing Save twice would make the proposal look
  // older than the takeoff and block its export for no reason.
  const [before] = await db
    .select()
    .from(takeoffsTable)
    .where(eq(takeoffsTable.jobId, jobId));
  const { updatedAt: _now, ...content } = values;
  const unchanged =
    before !== undefined &&
    sameJson(
      Object.fromEntries(
        Object.keys(content).map((k) => [k, (before as Record<string, unknown>)[k]]),
      ),
      content,
    );

  const [saved] = unchanged
    ? [before]
    : await db
        .insert(takeoffsTable)
        .values(values)
        .onConflictDoUpdate({ target: takeoffsTable.jobId, set: values })
        .returning();

  // First save moves the job forward in the pipeline.
  if (job.status === "takeoff") {
    await db
      .update(jobsTable)
      .set({ status: "proposal_ready", updatedAt: new Date() })
      .where(eq(jobsTable.id, jobId));
    req.log.info({ jobId }, "Takeoff saved; job moved to proposal_ready");
  }

  res.json(SaveTakeoffResponse.parse(serializeTakeoff(saved!)));
});

export default router;
