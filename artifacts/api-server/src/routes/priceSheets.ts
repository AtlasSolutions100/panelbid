import { Router, type IRouter } from "express";
import { asc, eq } from "drizzle-orm";
import {
  db,
  jobFilesTable,
  priceSheetExtractionsTable,
  priceSheetItemsTable,
  type PriceSheetExtractionRow,
  type PriceSheetItemRow,
} from "@workspace/db";
import {
  ExtractPriceSheetParams,
  ExtractPriceSheetResponse,
  GetPriceSheetExtractionParams,
  GetPriceSheetExtractionResponse,
  ListPriceSheetItemsParams,
  ListPriceSheetItemsResponse,
} from "@workspace/api-zod";
import {
  startPriceExtraction,
  isPriceExtractionRunning,
} from "../lib/priceSheetExtractor";
import { planFilePath } from "../lib/planFileStore";
import { requirePdfTools } from "../lib/pdfTools";
import { describeFailure } from "../lib/readingFailures";

const router: IRouter = Router();

function serializeExtraction(
  fileId: number,
  row: PriceSheetExtractionRow | undefined,
) {
  if (!row) {
    return {
      fileId,
      status: "not_started" as const,
      error: null,
      itemCount: 0,
      pagesProcessed: 0,
      pagesFailed: 0,
      updatedAt: null,
    };
  }
  return {
    fileId,
    // A row can be left "running" by a crashed server; trust the in-memory
    // in-flight set as the source of truth for liveness.
    status:
      row.status === "running" && !isPriceExtractionRunning(fileId)
        ? ("failed" as const)
        : (row.status as "running" | "completed" | "failed"),
    error:
      row.status === "running" && !isPriceExtractionRunning(fileId)
        ? "Extraction was interrupted (server restarted). Run it again."
        : row.error,
    itemCount: row.itemCount,
    pagesProcessed: row.pagesProcessed,
    pagesFailed: row.pagesFailed,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeItem(row: PriceSheetItemRow) {
  return {
    id: row.id,
    jobFileId: row.jobFileId,
    productDescription: row.productDescription,
    sheetSize: row.sheetSize,
    pricePerSheet: row.pricePerSheet,
    pricePerSqft: row.pricePerSqft,
    productCode: row.productCode,
    extractionConfidence: row.extractionConfidence,
    sourcePage: row.sourcePage,
    createdAt: row.createdAt.toISOString(),
  };
}

async function findFile(fileId: number) {
  const [file] = await db
    .select()
    .from(jobFilesTable)
    .where(eq(jobFilesTable.id, fileId));
  return file;
}

router.post("/files/:fileId/extract-prices", async (req, res): Promise<void> => {
  const params = ExtractPriceSheetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }
  const file = await findFile(params.data.fileId);
  if (!file) {
    res.status(404).json({ message: "File not found" });
    return;
  }

  // The reading itself runs after this answer. What can be known now is
  // refused here, in words, instead of failing unseen: a plan whose file
  // cannot be had (gone: 410), a server without its PDF tools (503).
  try {
    await planFilePath(file);
    await requirePdfTools();
  } catch (err) {
    const failure = describeFailure(err);
    req.log[failure.ours ? "error" : "warn"](
      { fileId: file.id, code: failure.body.code, reason: (err as { reason?: unknown }).reason },
      "Price extraction refused before it started",
    );
    res.status(failure.status).json(failure.body);
    return;
  }

  const started = startPriceExtraction(file);
  req.log.info(
    { fileId: file.id, started },
    started ? "Price extraction started" : "Price extraction already running",
  );

  const [row] = await db
    .select()
    .from(priceSheetExtractionsTable)
    .where(eq(priceSheetExtractionsTable.jobFileId, file.id));
  res
    .status(started ? 202 : 409)
    .json(ExtractPriceSheetResponse.parse(serializeExtraction(file.id, row)));
});

router.get(
  "/files/:fileId/price-extraction",
  async (req, res): Promise<void> => {
    const params = GetPriceSheetExtractionParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ message: params.error.message });
      return;
    }
    const file = await findFile(params.data.fileId);
    if (!file) {
      res.status(404).json({ message: "File not found" });
      return;
    }
    const [row] = await db
      .select()
      .from(priceSheetExtractionsTable)
      .where(eq(priceSheetExtractionsTable.jobFileId, file.id));
    res.json(
      GetPriceSheetExtractionResponse.parse(serializeExtraction(file.id, row)),
    );
  },
);

router.get("/files/:fileId/price-items", async (req, res): Promise<void> => {
  const params = ListPriceSheetItemsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }
  const file = await findFile(params.data.fileId);
  if (!file) {
    res.status(404).json({ message: "File not found" });
    return;
  }
  const rows = await db
    .select()
    .from(priceSheetItemsTable)
    .where(eq(priceSheetItemsTable.jobFileId, file.id))
    .orderBy(asc(priceSheetItemsTable.sourcePage), asc(priceSheetItemsTable.id));
  res.json(ListPriceSheetItemsResponse.parse(rows.map(serializeItem)));
});

export default router;
