import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, jobsTable, jobFilesTable, planScansTable } from "@workspace/db";
import {
  ListPlanScansParams,
  ListPlanScansResponse,
  RescanJobParams,
  RescanJobResponse,
} from "@workspace/api-zod";
import { scanFiles } from "../lib/planScanner";
import { isPlanFileError, planFileErrorBody } from "../lib/planFileStore";

const router: IRouter = Router();

router.get("/jobs/:jobId/scans", async (req, res): Promise<void> => {
  const params = ListPlanScansParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }

  const rows = await db
    .select({
      id: planScansTable.id,
      jobId: planScansTable.jobId,
      fileId: planScansTable.fileId,
      fileName: jobFilesTable.fileName,
      keywordId: planScansTable.keywordId,
      term: planScansTable.term,
      category: planScansTable.category,
      pageNumber: planScansTable.pageNumber,
      context: planScansTable.context,
      scannedAt: planScansTable.scannedAt,
    })
    .from(planScansTable)
    .innerJoin(jobFilesTable, eq(planScansTable.fileId, jobFilesTable.id))
    .where(eq(planScansTable.jobId, params.data.jobId))
    .orderBy(desc(planScansTable.scannedAt), planScansTable.pageNumber);

  res.json(
    ListPlanScansResponse.parse(
      rows.map((r) => ({ ...r, scannedAt: r.scannedAt.toISOString() })),
    ),
  );
});

router.post("/jobs/:jobId/scan", async (req, res): Promise<void> => {
  const params = RescanJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }

  const [job] = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(eq(jobsTable.id, params.data.jobId));
  if (!job) {
    res.status(404).json({ message: "Job not found" });
    return;
  }

  const files = await db
    .select()
    .from(jobFilesTable)
    .where(eq(jobFilesTable.jobId, job.id));

  let result;
  try {
    result = await scanFiles(files);
  } catch (err) {
    // Not one of the job's plans could be had: say why (gone is 410).
    if (isPlanFileError(err)) {
      req.log.warn({ jobId: job.id, code: err.code }, "Job rescan: no plan file could be had");
      res.status(err.status).json(planFileErrorBody(err));
      return;
    }
    throw err;
  }
  req.log.info({ jobId: job.id, ...result }, "Job rescan complete");
  res.json(RescanJobResponse.parse(result));
});

export default router;
