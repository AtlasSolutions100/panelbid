/**
 * Background polling worker — scans the connected Gmail inbox for new bid
 * invites, downloads any PDF attachments, creates jobs, and logs outcomes.
 *
 * Runs on a fixed interval (GMAIL_POLL_INTERVAL_MS, default 10 min).
 * Safe to call concurrently — a lock flag prevents overlap.
 */
import { eq, desc } from "drizzle-orm";
import { db, jobsTable, gmailConnectionsTable, processedEmailsTable } from "@workspace/db";
import { logger } from "./logger";
import { scanFiles } from "./planScanner";
import { storePlanFile, isPlanFileError } from "./planFileStore";
import { lookBackStartSeconds } from "./gmailLookBack";
import {
  gmailGetProfile,
  gmailListMessages,
  gmailGetMessage,
  gmailGetAttachment,
  decodeBase64Url,
  collectPdfParts,
  extractTextBody,
  getHeader,
} from "./gmailClient";
import { loadActiveContractorSources, matchContractor } from "./contractorMatch";
import {
  loadActiveExclusionTerms,
  loadActiveMaterialTerms,
  matchExclusionTerm,
  pdfLooksLikePlan,
} from "./emailFilter";
import type { ContractorSource } from "@workspace/db";

const POLL_INTERVAL_MS = Number(
  process.env.GMAIL_POLL_INTERVAL_MS ?? 10 * 60 * 1000,
);

// Max size of an inline (non-attachment) PDF we'll accept.
const MAX_INLINE_PDF_BYTES = 50 * 1024 * 1024;

let pollingTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse sender/subject into job name + address (best-effort). */
function parseJobFields(subject: string, body: string): { jobName: string; address: string; city: string } {
  // Look for patterns like "123 Main St, Springfield" in subject or first 500 chars of body.
  const text = `${subject}\n${body.slice(0, 500)}`;

  // City: grab last comma-separated segment before a state abbreviation.
  const cityMatch = text.match(/,\s*([A-Za-z ]{2,30}),?\s*[A-Z]{2}\b/);
  const city = cityMatch ? cityMatch[1].trim() : "";

  // Address: line that looks like a street address.
  const addrMatch = text.match(/\b\d{1,5}\s+[A-Za-z0-9 .,'#-]{5,60}/);
  const address = addrMatch ? addrMatch[0].trim().slice(0, 120) : "";

  // Job name: first non-empty line of subject (stripped of Re:, Fwd: etc.).
  const jobName =
    subject
      .replace(/^(re:|fwd?:|fw:)\s*/i, "")
      .trim()
      .slice(0, 120) || "Email Bid Invite";

  return { jobName, address, city };
}

/**
 * Extract a Google Drive file ID from a share link, or null when the URL
 * isn't a Drive file link. Supported forms:
 *   https://drive.google.com/file/d/FILE_ID/view?...
 *   https://drive.google.com/open?id=FILE_ID
 *   https://drive.google.com/uc?id=FILE_ID&...
 */
export function extractDriveFileId(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "drive.google.com") {
    return null;
  }
  const fileMatch = parsed.pathname.match(/^\/file\/d\/([A-Za-z0-9_-]+)/);
  if (fileMatch) return fileMatch[1]!;
  if (parsed.pathname === "/open" || parsed.pathname === "/uc") {
    const id = parsed.searchParams.get("id");
    if (id && /^[A-Za-z0-9_-]+$/.test(id)) return id;
  }
  return null;
}

/** Build Drive's direct-download URL for a file ID. */
function driveDownloadUrl(fileId: string): string {
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

/**
 * Scan email body for downloadable PDF URLs (https only). Direct .pdf links
 * are kept as-is; Google Drive share links are rewritten to Drive's
 * direct-download endpoint.
 */
export function extractPdfUrls(body: string): string[] {
  const urls = new Set<string>();

  // Direct HTTPS links ending in .pdf — plain http is not allowed (SSRF + privacy risk).
  const pdfRegex = /https:\/\/[^\s"'<>)]+\.pdf(?:\?[^\s"'<>)]*)?/gi;
  for (const match of body.match(pdfRegex) ?? []) urls.add(match);

  // Google Drive share links → direct-download endpoint.
  const driveRegex = /https:\/\/drive\.google\.com\/[^\s"'<>)]+/gi;
  for (const match of body.match(driveRegex) ?? []) {
    const fileId = extractDriveFileId(match);
    if (fileId) urls.add(driveDownloadUrl(fileId));
  }

  return [...urls];
}

/**
 * Resolve a hostname to its IPv4/IPv6 address and return it, or throw on
 * failure. Used for SSRF protection before any outbound fetch.
 */
async function resolveHostname(hostname: string): Promise<string> {
  const { lookup } = await import("node:dns/promises");
  const result = await lookup(hostname);
  return result.address;
}

/**
 * Return true when an IP address falls within loopback, link-local, or
 * RFC 1918 private ranges — all of which are off-limits for SSRF safety.
 */
function isPrivateIp(ip: string): boolean {
  // IPv6 loopback, unique-local (fc00::/7), link-local (fe80::/10)
  if (ip.includes(":")) {
    const norm = ip.toLowerCase();
    return (
      norm === "::1" ||
      norm.startsWith("fc") ||
      norm.startsWith("fd") ||
      norm.startsWith("fe8") ||
      norm.startsWith("fe9") ||
      norm.startsWith("fea") ||
      norm.startsWith("feb")
    );
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return true; // fail closed on unparseable
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 127 ||                        // 127.0.0.0/8  loopback
    a === 10 ||                         // 10.0.0.0/8   RFC 1918
    (a === 172 && b >= 16 && b <= 31) || // 172.16–31/12 RFC 1918
    (a === 192 && b === 168) ||          // 192.168.0.0/16 RFC 1918
    (a === 169 && b === 254) ||          // 169.254.0.0/16 link-local
    a === 0 ||                           // 0.x.x.x  reserved
    a === 100 && b >= 64 && b <= 127 ||  // 100.64.0.0/10 shared address
    a === 198 && (b === 18 || b === 19)  // 198.18.0.0/15 benchmarking
  );
}

/**
 * Validate that a URL and its resolved IP are safe to fetch:
 * - Must be HTTPS
 * - Hostname must resolve to a non-private, non-loopback IP
 * Throws an Error with a descriptive message if the check fails.
 */
async function assertSafeUrl(rawUrl: string): Promise<void> {
  // These messages end up in the log: they name the host, never the link.
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Non-HTTPS URL rejected (host ${parsed.hostname})`);
  }
  const ip = await resolveHostname(parsed.hostname);
  if (isPrivateIp(ip)) {
    throw new Error(
      `URL resolves to private/loopback IP (${ip}), host ${parsed.hostname}`,
    );
  }
}

/**
 * For the log: the host of a link found in an e-mail, never the link itself.
 * The link is the mail's content and can carry a key to the file.
 */
function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "(unreadable)";
  }
}

/**
 * Attempt to download a URL and return its bytes, or null on failure.
 * Includes SSRF protections: HTTPS-only, DNS pre-resolution with private-IP
 * blocking, post-redirect final URL re-validation, and streaming size check.
 */
/**
 * SSRF-safe fetch of a URL body (size-capped). Returns the raw bytes plus the
 * response content-type, or null when blocked/failed. Does NOT decide whether
 * the body is a PDF — callers check magic bytes.
 */
async function fetchUrlBody(url: string): Promise<{ buf: Buffer; contentType: string } | null> {
  // Pre-fetch SSRF check on the original URL.
  await assertSafeUrl(url);

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 30_000);

  const resp = await fetch(url, {
    signal: ac.signal,
    redirect: "follow",
    headers: { "User-Agent": "PanelBid/1.0" },
  });
  clearTimeout(timeout);

  if (!resp.ok) {
    logger.info({ host: hostOf(url), status: resp.status }, "PDF URL fetch returned non-OK status");
    return null;
  }

  // Re-validate the final URL after any redirects (redirect: "follow").
  if (resp.url && resp.url !== url) {
    try {
      await assertSafeUrl(resp.url);
    } catch (err) {
      logger.warn({ err, host: hostOf(url), finalHost: hostOf(resp.url) }, "SSRF: redirect to disallowed host blocked");
      return null;
    }
  }

  const contentType = resp.headers.get("content-type") ?? "";

  // Reject via Content-Length header before reading anything.
  const contentLength = Number(resp.headers.get("content-length") ?? "0");
  if (contentLength > MAX_INLINE_PDF_BYTES) {
    logger.warn({ host: hostOf(url), contentLength }, "PDF URL too large — skipped");
    return null;
  }

  // Stream with a hard size cap so a missing/wrong Content-Length can't cause OOM.
  const reader = resp.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > MAX_INLINE_PDF_BYTES) {
        reader.cancel().catch(() => {});
        logger.warn({ host: hostOf(url), totalBytes }, "PDF URL exceeded size limit mid-stream — skipped");
        return null;
      }
      chunks.push(value);
    }
  }
  if (totalBytes === 0) return null;
  return { buf: Buffer.concat(chunks.map((c) => Buffer.from(c))), contentType };
}

function isPdfBytes(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

/**
 * Parse Google Drive's virus-scan confirmation page (returned for large files)
 * and rebuild the real download URL from the confirmation form. Returns null
 * when the HTML isn't a recognizable confirmation page.
 */
export function parseDriveConfirmUrl(html: string): string | null {
  const formMatch = html.match(/<form[^>]+action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
  if (!formMatch) return null;
  const action = formMatch[1]!;
  if (!/^https:\/\/(drive|docs)\.(usercontent\.)?google\.com\//.test(action)) return null;
  const params = new URLSearchParams();
  const inputRegex = /<input[^>]+type="hidden"[^>]+name="([^"]+)"[^>]+value="([^"]*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = inputRegex.exec(formMatch[2]!)) !== null) {
    params.set(m[1]!, m[2]!);
  }
  if (!params.has("id") && !params.has("confirm")) return null;
  return `${action}?${params.toString()}`;
}

async function tryDownloadUrl(url: string): Promise<Buffer | null> {
  try {
    const result = await fetchUrlBody(url);
    if (!result) return null;

    // Accept anything that is actually a PDF (magic bytes), regardless of
    // content-type — Drive serves PDFs as application/octet-stream.
    if (isPdfBytes(result.buf)) return result.buf;

    const isHtml =
      result.contentType.includes("html") ||
      result.buf.subarray(0, 512).toString("latin1").toLowerCase().includes("<html");

    // Google Drive large files return an HTML virus-scan confirmation page.
    if (isHtml && url.includes("drive.google.com")) {
      const html = result.buf.toString("utf8");
      const confirmUrl = parseDriveConfirmUrl(html);
      if (confirmUrl) {
        logger.info({ host: hostOf(url) }, "Drive virus-scan confirmation page detected — following confirm link");
        const confirmed = await fetchUrlBody(confirmUrl);
        if (confirmed && isPdfBytes(confirmed.buf)) return confirmed.buf;
        logger.info(
          { host: hostOf(url), contentType: confirmed?.contentType },
          "Drive confirm follow-up did not yield a PDF",
        );
        return null;
      }
      logger.info({ host: hostOf(url) }, "Drive returned HTML but no confirmation form — file likely not publicly accessible");
      return null;
    }

    logger.info({ host: hostOf(url), contentType: result.contentType }, "URL did not return a PDF — skipped");
    return null;
  } catch (err) {
    logger.warn({ err, host: hostOf(url) }, "PDF URL download failed");
    return null;
  }
}

/**
 * Keep a PDF with its job, then trigger the keyword scan. The row and the
 * bytes go into the database in one transaction (lib/planFileStore.ts); the
 * disk copy is only a working copy.
 */
async function attachPdfToJob(
  jobId: number,
  pdfBuffer: Buffer,
  fileName: string,
): Promise<void> {
  const created = await storePlanFile({
    jobId,
    fileName,
    fileType: "application/pdf",
    buffer: pdfBuffer,
  });

  scanFiles([created])
    .then((r) =>
      logger.info({ jobId, fileId: created.id, ...r }, "Gmail auto-scan complete"),
    )
    .catch((err) =>
      logger.error({ err, jobId, fileId: created.id }, "Gmail auto-scan failed"),
    );
}

// ---------------------------------------------------------------------------
// Core poll logic
// ---------------------------------------------------------------------------

export async function pollOnce(): Promise<void> {
  if (isRunning) {
    logger.debug("Gmail poll skipped — previous run still in progress");
    return;
  }
  isRunning = true;
  try {
    // Check if Gmail integration is connected and enabled.
    const [connection] = await db
      .select()
      .from(gmailConnectionsTable)
      .limit(1);

    if (!connection || !connection.isEnabled) {
      logger.debug("Gmail polling disabled — no active connection");
      return;
    }

    if (connection.tokenStatus === "invalid") {
      logger.info("Gmail polling paused — connection needs to be reconnected");
      return;
    }

    logger.info({ connectionId: connection.id }, "Starting Gmail poll");

    // Build query: messages since the last poll, but never more than 7 days
    // back (a unix timestamp in seconds). After weeks without a poll (the
    // connection needed a reconnect) the gap is not swept in one go: see
    // lib/gmailLookBack.ts. First run: 7 days, as before.
    let query = "in:inbox has:attachment filename:pdf";
    query += ` after:${lookBackStartSeconds(connection.lastPolledAt, Date.now())}`;

    // Also scan for emails with PDF links in body (no attachment filter).
    const bodyQuery = query.replace("has:attachment filename:pdf", "");

    const now = new Date();

    // Collect all message IDs from both queries.
    const messageIds = new Set<string>();

    for (const q of [query, bodyQuery]) {
      let pageToken: string | undefined;
      do {
        const page = await gmailListMessages({ query: q, maxResults: 50, pageToken });
        for (const stub of page.messages ?? []) messageIds.add(stub.id);
        pageToken = page.nextPageToken;
      } while (pageToken);
    }

    logger.info({ count: messageIds.size }, "Gmail messages to evaluate");

    // Filter out already-processed message IDs.
    const newIds: string[] = [];
    for (const id of messageIds) {
      const [existing] = await db
        .select({ id: processedEmailsTable.id })
        .from(processedEmailsTable)
        .where(eq(processedEmailsTable.gmailMessageId, id))
        .limit(1);
      if (!existing) newIds.push(id);
    }

    logger.info({ newCount: newIds.length }, "New Gmail messages to process");

    // Known-contractor signal: loaded once per poll; never gates processing.
    let contractorSources: ContractorSource[] = [];
    try {
      contractorSources = await loadActiveContractorSources();
    } catch (err) {
      logger.warn({ err }, "Failed to load contractor sources — continuing without match signal");
    }

    for (const msgId of newIds) {
      await processMessage(msgId, contractorSources);
    }


    // Update last polled timestamp.
    await db
      .update(gmailConnectionsTable)
      .set({ lastPolledAt: now })
      .where(eq(gmailConnectionsTable.id, connection.id));

    logger.info("Gmail poll complete");
  } catch (err) {
    logger.error({ err }, "Gmail poll failed");
  } finally {
    isRunning = false;
  }
}

/**
 * Reprocess a specific message with the pre-filters bypassed ("Process
 * anyway" override from the activity log). The existing processed_emails
 * row is updated in place via recordOutcome's upsert.
 */
export async function reprocessMessageBypassingFilters(
  gmailMessageId: string,
): Promise<void> {
  let contractorSources: ContractorSource[] = [];
  try {
    contractorSources = await loadActiveContractorSources();
  } catch (err) {
    logger.warn({ err }, "Failed to load contractor sources — continuing without match signal");
  }
  await processMessage(gmailMessageId, contractorSources, { bypassFilters: true });
}

async function processMessage(
  gmailMessageId: string,
  contractorSources: ContractorSource[] = [],
  opts: { bypassFilters?: boolean } = {},
): Promise<void> {
  const bypassFilters = opts.bypassFilters === true;
  logger.info({ gmailMessageId, bypassFilters }, "Processing Gmail message");

  let sender = "";
  let subject = "";
  let receivedAt = new Date();
  let contractor: ContractorSource | null = null;

  try {
    const msg = await gmailGetMessage(gmailMessageId);
    const payload = msg.payload;
    if (!payload) {
      await recordOutcome({ gmailMessageId, sender, subject, receivedAt, outcome: "error", errorMessage: "No payload" });
      return;
    }

    sender = getHeader(payload, "From");
    subject = getHeader(payload, "Subject");
    contractor = matchContractor(sender, contractorSources);
    if (contractor) {
      logger.info(
        { gmailMessageId, contractorId: contractor.id },
        "Sender matched known contractor source",
      );
    }
    // Pre-filter 1: subject/sender exclusion terms (skippable via override).
    if (!bypassFilters) {
      try {
        const exclusionTerms = await loadActiveExclusionTerms();
        const hit = matchExclusionTerm(subject, sender, exclusionTerms);
        if (hit) {
          const reason = `Filtered — appears to be a bill/notification, not a bid request (matched "${hit.term}" in ${hit.field})`;
          logger.info({ gmailMessageId, field: hit.field }, "Email filtered by exclusion term");
          await recordOutcome({ gmailMessageId, sender, subject, receivedAt, outcome: "filtered", filterReason: reason, contractor });
          return;
        }
      } catch (err) {
        // Filter errors must never block bid processing — fail open.
        logger.warn({ err, gmailMessageId }, "Exclusion-term check failed — continuing without filter");
      }
    }

    const dateStr = getHeader(payload, "Date");
    if (dateStr) {
      const parsed = new Date(dateStr);
      if (!isNaN(parsed.getTime())) receivedAt = parsed;
    }

    // Collect PDF buffers.
    const pdfBuffers: Array<{ buf: Buffer; name: string }> = [];

    // 1. PDF attachments.
    const pdfParts = collectPdfParts(payload);
    for (const part of pdfParts) {
      const attachmentId = part.body?.attachmentId;
      const fileName = part.filename || "attachment.pdf";
      try {
        if (attachmentId) {
          const att = await gmailGetAttachment(gmailMessageId, attachmentId);
          const buf = decodeBase64Url(att.data);
          if (buf.length > 0 && buf.length <= MAX_INLINE_PDF_BYTES) {
            pdfBuffers.push({ buf, name: fileName });
          }
        } else if (part.body?.data) {
          // Inline small PDF.
          const buf = decodeBase64Url(part.body.data);
          if (buf.length > 0 && buf.length <= MAX_INLINE_PDF_BYTES) {
            pdfBuffers.push({ buf, name: fileName });
          }
        }
      } catch (err) {
        logger.warn({ err, gmailMessageId }, "Failed to download PDF attachment");
      }
    }

    // 2. PDF links in body.
    if (pdfBuffers.length === 0) {
      const body = extractTextBody(payload);
      const pdfUrls = extractPdfUrls(body);
      for (const url of pdfUrls.slice(0, 5)) {
        const buf = await tryDownloadUrl(url);
        if (buf) {
          let urlName = url.split("/").pop()?.split("?")[0] ?? "";
          // Drive download URLs (and other indirect links) don't carry a real
          // filename — fall back to a generic PDF name.
          if (!urlName.toLowerCase().endsWith(".pdf")) urlName = "plans.pdf";
          pdfBuffers.push({ buf, name: urlName });
        }
      }
    }

    if (pdfBuffers.length === 0) {
      logger.info({ gmailMessageId }, "No PDFs found in email");
      await recordOutcome({ gmailMessageId, sender, subject, receivedAt, outcome: "no_plans", contractor });
      return;
    }

    // Pre-filter 2: at least one PDF must look like a plan/bid document.
    // Image-only / unextractable PDFs fail open inside pdfLooksLikePlan.
    if (!bypassFilters) {
      try {
        const materialTerms = await loadActiveMaterialTerms();
        let anyPlausible = false;
        for (const { buf } of pdfBuffers) {
          if (await pdfLooksLikePlan(buf, materialTerms)) {
            anyPlausible = true;
            break;
          }
        }
        if (!anyPlausible) {
          const reason = "Filtered — attachment doesn't look like a plan/bid document";
          logger.info({ gmailMessageId, pdfCount: pdfBuffers.length }, "Email filtered by PDF plausibility check");
          await recordOutcome({ gmailMessageId, sender, subject, receivedAt, outcome: "filtered", filterReason: reason, contractor });
          return;
        }
      } catch (err) {
        // Filter errors must never block bid processing — fail open.
        logger.warn({ err, gmailMessageId }, "PDF plausibility check failed — continuing without filter");
      }
    }

    // Parse job fields from subject/body.
    const body = extractTextBody(payload);
    const { jobName, address, city } = parseJobFields(subject, body);

    // Create the job.
    const [job] = await db
      .insert(jobsTable)
      .values({ jobName, address, city, source: "email", status: "new" })
      .returning();

    if (!job) {
      await recordOutcome({ gmailMessageId, sender, subject, receivedAt, outcome: "error", errorMessage: "DB insert failed", contractor });
      return;
    }

    logger.info({ gmailMessageId, jobId: job.id, pdfCount: pdfBuffers.length }, "Created job from email");

    // Attach PDFs.
    for (const { buf, name } of pdfBuffers) {
      try {
        await attachPdfToJob(job.id, buf, name);
      } catch (err) {
        // A plan-file error carries a short reason; it never holds the bytes.
        if (isPlanFileError(err)) {
          logger.warn(
            { jobId: job.id, code: err.code, reason: "reason" in err ? err.reason : undefined },
            "Failed to attach PDF to job: nothing was added for it",
          );
        } else {
          logger.warn({ err, jobId: job.id }, "Failed to attach PDF to job");
        }
      }
    }

    await recordOutcome({ gmailMessageId, sender, subject, receivedAt, outcome: "job_created", jobId: job.id, contractor });
  } catch (err) {
    logger.error({ err, gmailMessageId }, "Failed to process Gmail message");
    await recordOutcome({
      gmailMessageId,
      sender,
      subject,
      receivedAt,
      outcome: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
      contractor,
    }).catch(() => {});
  }
}

async function recordOutcome(opts: {
  gmailMessageId: string;
  sender: string;
  subject: string;
  receivedAt: Date;
  outcome: "no_plans" | "job_created" | "error" | "filtered";
  jobId?: number;
  errorMessage?: string;
  filterReason?: string;
  contractor?: ContractorSource | null;
}): Promise<void> {
  const values = {
    gmailMessageId: opts.gmailMessageId,
    sender: opts.sender || "(unknown)",
    subject: opts.subject || "(no subject)",
    receivedAt: opts.receivedAt,
    outcome: opts.outcome,
    jobId: opts.jobId ?? null,
    errorMessage: opts.errorMessage ?? null,
    filterReason: opts.filterReason ?? null,
    matchedContractorId: opts.contractor?.id ?? null,
    matchedContractorName: opts.contractor?.name ?? null,
  };
  await db
    .insert(processedEmailsTable)
    .values(values)
    // Upsert: a "Process anyway" override reprocesses the same message and
    // must overwrite the previous (filtered) outcome. Also idempotent on
    // retry — the latest outcome wins.
    .onConflictDoUpdate({
      target: processedEmailsTable.gmailMessageId,
      set: { ...values, processedAt: new Date() },
    });
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export function startGmailPolling(): void {
  if (pollingTimer) return;
  // Run immediately on start, then on interval.
  pollOnce().catch((err) => logger.error({ err }, "Initial Gmail poll failed"));
  pollingTimer = setInterval(() => {
    pollOnce().catch((err) => logger.error({ err }, "Gmail poll interval failed"));
  }, POLL_INTERVAL_MS);
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "Gmail polling started");
}

export function stopGmailPolling(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
    logger.info("Gmail polling stopped");
  }
}
