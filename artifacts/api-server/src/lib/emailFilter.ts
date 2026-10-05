/**
 * Pre-filter for the Gmail worker — decides whether an email/PDF looks like
 * a real bid request before a job is created.
 *
 * Two checks, run in order:
 *  1. Subject/sender exclusion terms (editable in Settings).
 *  2. PDF plausibility — an attached PDF must look like a plan/bid document
 *     (multi-page, or bid-related terms co-occurring with a material
 *     keyword). Image-only / unextractable PDFs FAIL OPEN so scanned
 *     drawings still create jobs.
 */
import { eq } from "drizzle-orm";
import {
  db,
  exclusionTermsTable,
  keywordsTable,
  type ExclusionTerm,
} from "@workspace/db";
import { logger } from "./logger";

// Terms that indicate a document is a bid/plan package. Checked alongside
// material keywords in single-page PDFs.
const BID_TERMS = [
  "bid",
  "proposal",
  "plans",
  "plan set",
  "drawing",
  "drawings",
  "finish schedule",
  "specification",
  "spec section",
  "scope of work",
  "takeoff",
  "rfp",
  "rfq",
  "invitation to bid",
  "addendum",
  "blueprint",
  "elevation",
  "floor plan",
];

export async function loadActiveExclusionTerms(): Promise<ExclusionTerm[]> {
  return db
    .select()
    .from(exclusionTermsTable)
    .where(eq(exclusionTermsTable.active, true));
}

export interface ExclusionHit {
  term: string;
  field: "subject" | "sender";
}

/**
 * Return the first exclusion term matching the subject/sender, or null when
 * the email passes. Case-insensitive substring match.
 */
export function matchExclusionTerm(
  subject: string,
  sender: string,
  terms: ExclusionTerm[],
): ExclusionHit | null {
  const subj = subject.toLowerCase();
  const from = sender.toLowerCase();
  for (const t of terms) {
    const needle = t.term.trim().toLowerCase();
    if (!needle) continue;
    if (
      (t.matchType === "subject" || t.matchType === "either") &&
      subj.includes(needle)
    ) {
      return { term: t.term, field: "subject" };
    }
    if (
      (t.matchType === "sender" || t.matchType === "either") &&
      from.includes(needle)
    ) {
      return { term: t.term, field: "sender" };
    }
  }
  return null;
}

/** Load active material keyword terms (plan-scanner keyword list). */
export async function loadActiveMaterialTerms(): Promise<string[]> {
  const rows = await db
    .select({ term: keywordsTable.term })
    .from(keywordsTable)
    .where(eq(keywordsTable.active, true));
  return rows.map((r) => r.term);
}

/**
 * Decide whether a PDF buffer looks like a plan/bid document.
 *
 * Passes when:
 *  - text extraction fails or yields no text (image-only scan → fail open), or
 *  - the PDF has multiple pages, or
 *  - a bid-related term AND a material keyword both appear in the text.
 *
 * A single isolated material-keyword hit in a one-page PDF is NOT enough.
 */
export async function pdfLooksLikePlan(
  buffer: Buffer,
  materialTerms: string[],
): Promise<boolean> {
  let pages: string[];
  try {
    const { extractText } = await import("unpdf");
    const { text } = await extractText(new Uint8Array(buffer), {
      mergePages: false,
    });
    pages = text.map((p) => p.replace(/\s+/g, " ").trim());
  } catch (err) {
    logger.info({ err }, "Pre-filter: PDF text extraction failed — failing open");
    return true; // image-only / broken PDFs must not be filtered out
  }

  const hasText = pages.some((p) => p.length > 0);
  if (!hasText) return true; // image-only scan — fail open

  if (pages.length > 1) return true; // multi-page documents pass

  const content = pages.join(" ").toLowerCase();
  const hasBidTerm = BID_TERMS.some((t) => content.includes(t));
  const hasMaterial = materialTerms.some(
    (t) => t.trim() && content.includes(t.trim().toLowerCase()),
  );
  return hasBidTerm && hasMaterial;
}
