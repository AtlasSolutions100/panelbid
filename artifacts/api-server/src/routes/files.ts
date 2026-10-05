import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import multer from "multer";
import { desc, eq } from "drizzle-orm";
import { db, jobsTable, jobFilesTable } from "@workspace/db";
import {
  ListJobFilesParams,
  ListJobFilesResponse,
  UploadJobFileParams,
  UploadJobFileResponse,
  DownloadJobFileParams,
  DeleteJobFileParams,
} from "@workspace/api-zod";
import { scanFiles } from "../lib/planScanner";

const router: IRouter = Router();

function serializeFile<T extends { uploadedAt: Date }>(file: T) {
  return { ...file, uploadedAt: file.uploadedAt.toISOString() };
}

// Local file storage. Kept behind this module so a future storage service
// (e.g. object storage) can replace it without touching the API contract.
const UPLOAD_DIR = path.resolve(
  process.env.UPLOAD_DIR ?? path.join(process.cwd(), "uploads"),
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

router.get("/jobs/:jobId/files", async (req, res): Promise<void> => {
  const params = ListJobFilesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }

  const files = await db
    .select()
    .from(jobFilesTable)
    .where(eq(jobFilesTable.jobId, params.data.jobId))
    .orderBy(desc(jobFilesTable.uploadedAt));
  res.json(ListJobFilesResponse.parse(files.map(serializeFile)));
});

router.post(
  "/jobs/:jobId/files",
  upload.single("file"),
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
      res.status(400).json({ message: "No file provided (field 'file')" });
      return;
    }

    const isPdf =
      file.mimetype === "application/pdf" ||
      file.originalname.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      res.status(400).json({ message: "Only PDF files are accepted" });
      return;
    }

    const fileHash = createHash("sha256").update(file.buffer).digest("hex");

    const jobDir = path.join(UPLOAD_DIR, String(job.id));
    await mkdir(jobDir, { recursive: true });
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storedName = `${Date.now()}_${safeName}`;
    const filePath = path.join(jobDir, storedName);
    await writeFile(filePath, file.buffer);

    let created;
    try {
      [created] = await db
        .insert(jobFilesTable)
        .values({
          jobId: job.id,
          fileName: file.originalname,
          filePath,
          fileHash,
          fileType: file.mimetype || "application/pdf",
          fileSize: file.size,
        })
        .returning();
    } catch (err) {
      // Compensate: don't leave orphaned bytes on disk if the DB insert fails.
      await unlink(filePath).catch(() => {});
      throw err;
    }

    req.log.info(
      { jobId: job.id, fileId: created!.id, fileHash },
      "File uploaded",
    );
    res.status(201).json(UploadJobFileResponse.parse(serializeFile(created!)));

    // Kick off keyword scanning for the new file (fire-and-forget so the
    // upload response stays fast; results appear via the scans endpoint).
    const log = req.log;
    scanFiles([created!])
      .then((result) => log.info({ fileId: created!.id, ...result }, "Auto-scan complete"))
      .catch((err) => log.error({ err, fileId: created!.id }, "Auto-scan failed"));
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

  if (!file || !existsSync(file.filePath)) {
    res.status(404).json({ message: "File not found" });
    return;
  }

  res.download(file.filePath, file.fileName);
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

  if (!file || !existsSync(file.filePath)) {
    res.status(404).json({ message: "File not found" });
    return;
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${encodeURIComponent(file.fileName)}"`,
  );
  res.sendFile(file.filePath);
});

router.delete("/files/:fileId", async (req, res): Promise<void> => {
  const params = DeleteJobFileParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(jobFilesTable)
    .where(eq(jobFilesTable.id, params.data.fileId))
    .returning();

  if (!deleted) {
    res.status(404).json({ message: "File not found" });
    return;
  }

  if (existsSync(deleted.filePath)) {
    await unlink(deleted.filePath).catch((err) => {
      req.log.warn({ err, filePath: deleted.filePath }, "Failed to unlink file");
    });
  }
  res.sendStatus(204);
});

export default router;
