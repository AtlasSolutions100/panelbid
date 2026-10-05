import { Router, type IRouter } from "express";
import path from "node:path";
import { rm } from "node:fs/promises";
import { desc, eq, sql } from "drizzle-orm";
import { db, jobsTable, jobFilesTable } from "@workspace/db";
import {
  CreateJobBody,
  CreateJobResponse,
  ListJobsResponse,
  GetJobsSummaryResponse,
  GetJobParams,
  GetJobResponse,
  UpdateJobParams,
  UpdateJobBody,
  UpdateJobResponse,
  DeleteJobParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

function serializeJob<
  T extends { createdAt: Date; updatedAt: Date },
>(job: T) {
  return {
    ...job,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

const fileCountExpr = sql<number>`(select count(*)::int from ${jobFilesTable} where ${jobFilesTable.jobId} = ${jobsTable.id})`;

function selectJobWithCount() {
  return db
    .select({
      id: jobsTable.id,
      jobName: jobsTable.jobName,
      address: jobsTable.address,
      city: jobsTable.city,
      source: jobsTable.source,
      status: jobsTable.status,
      createdAt: jobsTable.createdAt,
      updatedAt: jobsTable.updatedAt,
      fileCount: fileCountExpr,
    })
    .from(jobsTable);
}

router.get("/jobs", async (_req, res): Promise<void> => {
  const jobs = await selectJobWithCount().orderBy(desc(jobsTable.createdAt));
  res.json(ListJobsResponse.parse(jobs.map(serializeJob)));
});

router.post("/jobs", async (req, res): Promise<void> => {
  const parsed = CreateJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }

  const [created] = await db.insert(jobsTable).values(parsed.data).returning();
  res
    .status(201)
    .json(CreateJobResponse.parse(serializeJob({ ...created!, fileCount: 0 })));
});

router.get("/jobs/summary", async (_req, res): Promise<void> => {
  const rows = await db
    .select({ status: jobsTable.status, count: sql<number>`count(*)::int` })
    .from(jobsTable)
    .groupBy(jobsTable.status);

  const byStatus: Record<string, number> = {
    new: 0,
    analyzing: 0,
    needs_review: 0,
    takeoff: 0,
    proposal_ready: 0,
    discarded: 0,
  };
  let total = 0;
  for (const row of rows) {
    byStatus[row.status] = row.count;
    total += row.count;
  }
  res.json(GetJobsSummaryResponse.parse({ total, byStatus }));
});

router.get("/jobs/:jobId", async (req, res): Promise<void> => {
  const params = GetJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }

  const [job] = await selectJobWithCount().where(
    eq(jobsTable.id, params.data.jobId),
  );
  if (!job) {
    res.status(404).json({ message: "Job not found" });
    return;
  }
  res.json(GetJobResponse.parse(serializeJob(job)));
});

router.patch("/jobs/:jobId", async (req, res): Promise<void> => {
  const params = UpdateJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }
  const parsed = UpdateJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }

  const [updated] = await db
    .update(jobsTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(jobsTable.id, params.data.jobId))
    .returning();

  if (!updated) {
    res.status(404).json({ message: "Job not found" });
    return;
  }

  const [job] = await selectJobWithCount().where(
    eq(jobsTable.id, params.data.jobId),
  );
  res.json(UpdateJobResponse.parse(serializeJob(job!)));
});

router.delete("/jobs/:jobId", async (req, res): Promise<void> => {
  const params = DeleteJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(jobsTable)
    .where(eq(jobsTable.id, params.data.jobId))
    .returning();

  if (!deleted) {
    res.status(404).json({ message: "Job not found" });
    return;
  }

  // Remove the job's uploaded files from disk (DB rows cascade automatically).
  const uploadDir = path.resolve(
    process.env.UPLOAD_DIR ?? path.join(process.cwd(), "uploads"),
  );
  await rm(path.join(uploadDir, String(deleted.id)), {
    recursive: true,
    force: true,
  }).catch((err) => {
    req.log.warn({ err, jobId: deleted.id }, "Failed to remove job files dir");
  });

  res.sendStatus(204);
});

export default router;
