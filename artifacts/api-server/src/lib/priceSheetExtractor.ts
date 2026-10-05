import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  jobFilesTable,
  priceSheetExtractionsTable,
  priceSheetItemsTable,
  type JobFile,
  type InsertPriceSheetItem,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { renderPageImages } from "./specExtractor";
import { logger } from "./logger";

const execFileAsync = promisify(execFile);

// Files with a price extraction currently in flight — a second concurrent run
// for the same file would race the first and interleave partial results.
const priceExtractionInFlight = new Set<number>();

export function isPriceExtractionRunning(fileId: number): boolean {
  return priceExtractionInFlight.has(fileId);
}

const ExtractedPriceItem = z.object({
  product_description: z.string().nullable(),
  sheet_size: z.string().nullable(),
  price_per_sheet: z.number().nullable(),
  price_per_sqft: z.number().nullable(),
  product_code: z.string().nullable(),
});

const PricePagePayload = z.object({
  items: z.array(ExtractedPriceItem),
});

const PRICE_EXTRACTION_PROMPT = `You are reading one page of a MANUFACTURER PRICE SHEET for wall panel products (FRP, PVC, stainless steel liner panels, moldings, trims, adhesives, etc.).

Extract every priced line item visible on this page. For each item capture:
- product_description: the product name/description as printed (e.g. "Glasbord P .090 Embossed White").
- sheet_size: the sheet size when the item is a panel sold by sheet, exactly as printed but normalized to WxL feet when obvious (e.g. "4x8", "4x10"). Use null when no size applies (adhesives, trims) or none is shown.
- price_per_sheet: the price for one full sheet, as a number without currency symbols. Null if not shown.
- price_per_sqft: the price per square foot as a number. Null if not shown.
- product_code: the manufacturer's product/item code or SKU (e.g. "85SM.090"). Null if none shown.

Rules:
- If a field cannot be determined from this page, use null. NEVER guess, infer, or compute values not printed on the page (do not derive price per sheet from price per sqft or vice versa).
- One entry per distinct priced row — if the same product is priced in several sheet sizes, emit one entry per size.
- Skip rows with no price information at all.
- Read carefully in the tiles; prices and codes are often small text.

Respond with ONLY strict JSON (no markdown fences, no commentary) in this exact shape:
{
  "items": [
    {"product_description": string|null, "sheet_size": string|null, "price_per_sheet": number|null, "price_per_sqft": number|null, "product_code": string|null}
  ]
}`;

async function extractPricesFromPage(
  images: Buffer[],
): Promise<z.infer<typeof PricePagePayload>> {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "The first image is the full price-sheet page for overall context. The following images are overlapping full-resolution tiles of the SAME page, in reading order (left to right, top to bottom) — use them to read small text such as prices and product codes.",
          },
          ...images.map(
            (image) =>
              ({
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: image.toString("base64"),
                },
              }) as const,
          ),
          { type: "text", text: PRICE_EXTRACTION_PROMPT },
        ],
      },
    ],
  });
  const block = message.content[0];
  const text = block && block.type === "text" ? block.text : "";
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("Model response contained no JSON object");
  }
  return PricePagePayload.parse(JSON.parse(cleaned.slice(start, end + 1)));
}

async function getPageCount(pdfPath: string): Promise<number> {
  const { stdout } = await execFileAsync("pdfinfo", [pdfPath]);
  const m = stdout.match(/^Pages:\s+(\d+)/m);
  if (!m) throw new Error("Could not determine PDF page count");
  return parseInt(m[1]!, 10);
}

async function upsertStatus(
  jobFileId: number,
  values: Partial<typeof priceSheetExtractionsTable.$inferInsert>,
): Promise<void> {
  const row = { jobFileId, status: "running", ...values, updatedAt: new Date() };
  await db
    .insert(priceSheetExtractionsTable)
    .values(row)
    .onConflictDoUpdate({
      target: priceSheetExtractionsTable.jobFileId,
      set: row,
    });
}

/**
 * Run the full price-sheet extraction for one job file. Marks the extraction
 * row running → completed/failed as it goes; replaces the file's items only
 * when at least one page succeeded.
 */
async function runPriceExtraction(file: JobFile): Promise<void> {
  const pageCount = await getPageCount(file.filePath);
  // Price sheets are catalogs; cap pages to keep a run bounded.
  const maxPages = Math.min(pageCount, 20);

  const items: InsertPriceSheetItem[] = [];
  let pagesProcessed = 0;
  let pagesFailed = 0;

  for (let page = 1; page <= maxPages; page++) {
    try {
      const images = await renderPageImages(file.filePath, page);
      const payload = await extractPricesFromPage(images);
      pagesProcessed++;
      for (const item of payload.items) {
        // Skip rows with no pricing at all — they can't fill anything.
        if (item.price_per_sheet == null && item.price_per_sqft == null) continue;
        const ambiguous =
          item.product_description == null ||
          (item.price_per_sheet == null && item.sheet_size == null);
        items.push({
          jobFileId: file.id,
          productDescription: item.product_description,
          sheetSize: item.sheet_size,
          pricePerSheet: item.price_per_sheet,
          pricePerSqft: item.price_per_sqft,
          productCode: item.product_code,
          extractionConfidence: ambiguous ? "ambiguous" : "high",
          sourcePage: page,
        });
      }
      await upsertStatus(file.id, {
        status: "running",
        pagesProcessed,
        pagesFailed,
        itemCount: items.length,
      });
    } catch (err) {
      pagesFailed++;
      logger.error(
        { err, fileId: file.id, page },
        "Price extraction failed for page",
      );
    }
  }

  if (pagesProcessed === 0) {
    throw new Error(
      `Price extraction failed: 0 of ${maxPages} pages could be processed`,
    );
  }

  // Replace this file's items atomically.
  await db.transaction(async (tx) => {
    await tx
      .delete(priceSheetItemsTable)
      .where(eq(priceSheetItemsTable.jobFileId, file.id));
    if (items.length > 0) {
      await tx.insert(priceSheetItemsTable).values(items);
    }
  });

  await upsertStatus(file.id, {
    status: "completed",
    error: null,
    pagesProcessed,
    pagesFailed,
    itemCount: items.length,
  });
  logger.info(
    { fileId: file.id, pagesProcessed, pagesFailed, items: items.length },
    "Price extraction complete",
  );
}

/**
 * Start extraction in the background. Returns false when a run is already in
 * flight for this file.
 */
export function startPriceExtraction(file: JobFile): boolean {
  if (priceExtractionInFlight.has(file.id)) return false;
  priceExtractionInFlight.add(file.id);

  void (async () => {
    try {
      await upsertStatus(file.id, {
        status: "running",
        error: null,
        pagesProcessed: 0,
        pagesFailed: 0,
        itemCount: 0,
        startedAt: new Date(),
      });
      await runPriceExtraction(file);
    } catch (err) {
      logger.error({ err, fileId: file.id }, "Price extraction failed");
      await upsertStatus(file.id, {
        status: "failed",
        error: err instanceof Error ? err.message : "Price extraction failed",
      }).catch(() => {});
    } finally {
      priceExtractionInFlight.delete(file.id);
    }
  })();

  return true;
}
