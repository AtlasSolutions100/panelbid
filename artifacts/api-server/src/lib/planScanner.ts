import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import {
  db,
  jobFilesTable,
  keywordsTable,
  planScansTable,
  type JobFile,
  type InsertPlanScan,
} from "@workspace/db";
import { logger } from "./logger";
import { isPlanFileError, planFilePath } from "./planFileStore";

const CONTEXT_RADIUS = 90;
// Advisory lock namespace for plan-scan serialization (arbitrary app-unique int).
const PLAN_SCAN_LOCK_NS = 74201;

/** Extract text per page from a PDF buffer. Returns one string per page. */
async function extractPdfPages(buffer: Buffer): Promise<string[]> {
  const { extractText } = await import("unpdf");
  const { text } = await extractText(new Uint8Array(buffer), {
    mergePages: false,
  });
  return text.map((page) => page.replace(/\s+/g, " ").trim());
}

function findMatches(
  pageText: string,
  term: string,
): { context: string }[] {
  const matches: { context: string }[] = [];
  const haystack = pageText.toLowerCase();
  const needle = term.toLowerCase();
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    const start = Math.max(0, idx - CONTEXT_RADIUS);
    const end = Math.min(pageText.length, idx + needle.length + CONTEXT_RADIUS);
    const context =
      (start > 0 ? "…" : "") +
      pageText.slice(start, end).trim() +
      (end < pageText.length ? "…" : "");
    matches.push({ context });
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return matches;
}

export interface ScanRunResult {
  /** Files whose pages were read this run (not the ones that could not be had). */
  filesScanned: number;
  matchCount: number;
  filesNeedingOcr: number;
  /**
   * Ids of the plans left out because their file could not be had (gone:
   * upload again). Ids only: this result is written to the log as it is.
   */
  filesNotThere: number[];
}

/**
 * Scan the given files against all active keywords. Replaces any previous
 * scan results for those files. Sets needs_ocr on files with no extractable text.
 *
 * A plan whose file cannot be had (lib/planFileStore.ts) is left out and
 * named in filesNotThere; the plans that are there are still scanned. When
 * NOT ONE of the given files could be had, the plan-file error itself is
 * thrown (gone is 410), so the person is told why nothing was scanned.
 */
export async function scanFiles(files: JobFile[]): Promise<ScanRunResult> {
  const keywords = await db
    .select()
    .from(keywordsTable)
    .where(eq(keywordsTable.active, true));

  let matchCount = 0;
  let filesNeedingOcr = 0;
  let filesScanned = 0;
  // A plan whose file cannot be had (gone, or not put back) is NOT marked
  // "needs OCR": that would say something about its pages, and nobody has
  // seen them. Its earlier results are left alone.
  let fileProblem: unknown = null;
  const filesNotThere: number[] = [];

  for (const file of files) {
    let onDisk: string;
    try {
      onDisk = await planFilePath(file);
    } catch (err) {
      if (!isPlanFileError(err)) throw err;
      fileProblem ??= err;
      filesNotThere.push(file.id);
      continue;
    }
    filesScanned++;

    let pages: string[] = [];
    let extractionFailed = false;
    try {
      const buffer = await readFile(onDisk);
      pages = await extractPdfPages(buffer);
    } catch (err) {
      extractionFailed = true;
      logger.warn({ err, fileId: file.id }, "PDF text extraction failed");
    }

    const hasText = pages.some((p) => p.length > 0);
    const needsOcr = extractionFailed || !hasText;
    if (needsOcr) filesNeedingOcr++;

    const rows: InsertPlanScan[] = [];
    if (!needsOcr) {
      for (let p = 0; p < pages.length; p++) {
        const pageText = pages[p]!;
        if (!pageText) continue;
        for (const keyword of keywords) {
          for (const match of findMatches(pageText, keyword.term)) {
            rows.push({
              jobId: file.jobId,
              fileId: file.id,
              keywordId: keyword.id,
              term: keyword.term,
              category: keyword.category,
              pageNumber: p + 1,
              context: match.context,
            });
          }
        }
      }
    }
    matchCount += rows.length;

    // Atomically replace this file's results. The transaction-scoped
    // advisory lock (keyed by file id) serializes concurrent scans of the
    // same file (e.g. upload auto-scan racing a manual rescan), so
    // "delete old + insert new" can never interleave with another run.
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${PLAN_SCAN_LOCK_NS}, ${file.id})`,
      );
      await tx
        .update(jobFilesTable)
        .set({ needsOcr })
        .where(eq(jobFilesTable.id, file.id));
      await tx
        .delete(planScansTable)
        .where(eq(planScansTable.fileId, file.id));
      if (rows.length > 0) {
        await tx.insert(planScansTable).values(rows);
      }
    });
  }

  if (fileProblem && filesScanned === 0) throw fileProblem;

  return { filesScanned, matchCount, filesNeedingOcr, filesNotThere };
}
