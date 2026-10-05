import {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import multer from "multer";
import { desc, eq } from "drizzle-orm";
import { db, jobsTable, jobFilesTable, type JobFile } from "@workspace/db";
import {
  ListJobFilesParams,
  ListJobFilesResponse,
  UploadJobFileParams,
  UploadJobFileResponse,
  DownloadJobFileParams,
  DeleteJobFileParams,
} from "@workspace/api-zod";
import { scanFiles } from "../lib/planScanner";
import {
  MAX_PLAN_FILE_BYTES,
  PLAN_TOO_BIG_MESSAGE,
  isPlanFileError,
  planFileErrorBody,
  planFilePath,
  removeDiskCopy,
  storePlanFile,
} from "../lib/planFileStore";

const router: IRouter = Router();

function serializeFile<T extends { uploadedAt: Date }>(file: T) {
  return { ...file, uploadedAt: file.uploadedAt.toISOString() };
}

// Where a plan's bytes live (the database, with a working copy on the disk)
// is lib/planFileStore.ts. This file never opens `filePath` itself.

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PLAN_FILE_BYTES }, // 50 MB
});

export const NOT_A_PDF_MESSAGE = "That file is not a PDF. Plans must be PDF files.";
export const UPLOAD_BROKEN_MESSAGE =
  "The file did not arrive whole. Check your connection and upload it again.";
export const NO_FILE_MESSAGE = "No file arrived. Choose a PDF and upload it again.";

/** multer, with its refusals turned into a status and a sentence. */
function receiveOneFile(req: Request, res: Response, next: NextFunction): void {
  upload.single("file")(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ code: "plan_too_big", message: PLAN_TOO_BIG_MESSAGE });
        return;
      }
      req.log.warn({ multerCode: err.code }, "Upload refused");
      res.status(400).json({ code: "upload_broken", message: UPLOAD_BROKEN_MESSAGE });
      return;
    }
    next(err);
  });
}

/**
 * Answer with the status and the sentence of a plan-file error (gone: 410).
 * False when the error is something else: the caller passes it on.
 */
function answeredPlanFileError(res: Response, err: unknown): boolean {
  if (!isPlanFileError(err)) return false;
  res.status(err.status).json(planFileErrorBody(err));
  return true;
}

router.get("/jobs/:jobId/files", async (req, res): Promise<void> => {
  const params = ListJobFilesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }

  // The rows only: a list never reads the files' bytes.
  const files = await db
    .select()
    .from(jobFilesTable)
    .where(eq(jobFilesTable.jobId, params.data.jobId))
    .orderBy(desc(jobFilesTable.uploadedAt));
  res.json(ListJobFilesResponse.parse(files.map(serializeFile)));
});

router.post(
  "/jobs/:jobId/files",
  receiveOneFile,
  async (req, res): Promise<void> => {
    const params = UploadJobFileParams.safeParse(req.params);
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

    const file = req.file;
    if (!file) {
      res.status(400).json({ code: "no_file", message: NO_FILE_MESSAGE });
      return;
    }

    const isPdf =
      file.mimetype === "application/pdf" ||
      file.originalname.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      res.status(415).json({ code: "not_a_pdf", message: NOT_A_PDF_MESSAGE });
      return;
    }

    // The row and the bytes are stored together or not at all.
    let created: JobFile;
    try {
      created = await storePlanFile({
        jobId: job.id,
        fileName: file.originalname,
        fileType: file.mimetype || "application/pdf",
        buffer: file.buffer,
      });
    } catch (err) {
      if (isPlanFileError(err)) {
        req.log.error(
          { jobId: job.id, code: err.code, reason: "reason" in err ? err.reason : undefined },
          "Upload could not be stored: nothing was added",
        );
        res.status(err.status).json(planFileErrorBody(err));
        return;
      }
      throw err;
    }

    req.log.info(
      { jobId: job.id, fileId: created.id, fileHash: created.fileHash, bytes: created.fileSize },
      "File uploaded: row and bytes stored in the database",
    );
    res.status(201).json(UploadJobFileResponse.parse(serializeFile(created)));

    // Kick off keyword scanning for the new file (fire-and-forget so the
    // upload response stays fast; results appear via the scans endpoint).
    const log = req.log;
    scanFiles([created])
      .then((result) => log.info({ fileId: created.id, ...result }, "Auto-scan complete"))
      .catch((err) => log.error({ err, fileId: created.id }, "Auto-scan failed"));
  },
);

router.get("/files/:fileId/download", async (req, res): Promise<void> => {
  const params = DownloadJobFileParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }

  const [file] = await db
    .select()
    .from(jobFilesTable)
    .where(eq(jobFilesTable.id, params.data.fileId));

  if (!file) {
    res.status(404).json({ message: "File not found" });
    return;
  }

  let onDisk: string;
  try {
    onDisk = await planFilePath(file);
  } catch (err) {
    if (answeredPlanFileError(res, err)) return;
    throw err;
  }

  res.download(onDisk, file.fileName);
});

// Inline PDF view (opens in the browser so #page= anchors work).
router.get("/files/:fileId/view", async (req, res): Promise<void> => {
  const params = DownloadJobFileParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }

  const [file] = await db
    .select()
    .from(jobFilesTable)
    .where(eq(jobFilesTable.id, params.data.fileId));

  if (!file) {
    res.status(404).json({ message: "File not found" });
    return;
  }

  let onDisk: string;
  try {
    onDisk = await planFilePath(file);
  } catch (err) {
    if (answeredPlanFileError(res, err)) return;
    throw err;
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${encodeURIComponent(file.fileName)}"`,
  );
  res.sendFile(onDisk);
});

router.delete("/files/:fileId", async (req, res): Promise<void> => {
  const params = DeleteJobFileParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }

  // Deleting the row deletes its bytes too (job_file_blobs cascades).
  const [deleted] = await db
    .delete(jobFilesTable)
    .where(eq(jobFilesTable.id, params.data.fileId))
    .returning();

  if (!deleted) {
    res.status(404).json({ message: "File not found" });
    return;
  }

  // The working copy, when there is one.
  await removeDiskCopy(deleted);
  res.sendStatus(204);
});

export default router;
