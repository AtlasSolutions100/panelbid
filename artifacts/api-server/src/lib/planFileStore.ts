/**
 * Where a plan file lives.
 *
 * The host throws the server's disk away whenever it restarts or publishes.
 * So the bytes of every plan are kept in the database (job_file_blobs), in
 * the same transaction as the file's row, and the copy under uploads/ is
 * only a working copy: when it is missing it is brought back from the table.
 *
 * Two doors, and nothing else touches a plan file:
 *   - storePlanFile(): the one way a plan is added (upload, e-mail).
 *   - planFilePath():  the one way a reader gets a path it can open. No
 *     reader uses `file.filePath` directly.
 *
 * The bytes are only held in memory to store them (the upload is already in
 * memory) and are brought back in pieces, never as one value.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  db,
  pool,
  jobFilesTable,
  jobFileBlobsTable,
  type JobFile,
} from "@workspace/db";
import { logger } from "./logger";

export const UPLOAD_DIR = path.resolve(
  process.env.UPLOAD_DIR ?? path.join(process.cwd(), "uploads"),
);

/** The biggest plan the app takes: 50 MB. */
export const MAX_PLAN_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_PLAN_FILE_MB = MAX_PLAN_FILE_BYTES / (1024 * 1024);

// The sentences a person sees. Plain words, no paths, no code words.
export const PLAN_FILE_GONE_MESSAGE =
  "This plan's file is no longer on the server. Upload it again.";
export const PLAN_FILE_NOT_RESTORED_MESSAGE =
  "This plan's file could not be put back on the server. Try again in a minute.";
export const PLAN_NOT_SAVED_MESSAGE =
  "The plan could not be saved on the server, so nothing was added. Try again.";
export const PLAN_TOO_BIG_MESSAGE = `This file is too big. The limit is ${MAX_PLAN_FILE_MB} MB.`;

/** Size of one piece when a file is brought back from the database. */
const RESTORE_PIECE_BYTES = 4 * 1024 * 1024;

/**
 * The plan's row is there but its file is not on the disk and the database
 * holds no bytes for it (a plan from before the bytes were kept).
 */
export class PlanFileGoneError extends Error {
  readonly code = "plan_file_gone";
  readonly status = 410;
  constructor(
    readonly fileId: number,
    readonly fileName: string | null = null,
  ) {
    super(PLAN_FILE_GONE_MESSAGE);
    this.name = "PlanFileGoneError";
  }
}

/** The bytes are in the database but could not be put back on the disk. */
export class PlanFileRestoreError extends Error {
  readonly code = "plan_file_not_restored";
  readonly status = 500;
  constructor(
    readonly fileId: number,
    /** For the server log only. */
    readonly reason: string,
  ) {
    super(PLAN_FILE_NOT_RESTORED_MESSAGE);
    this.name = "PlanFileRestoreError";
  }
}

/** A new plan could not be stored. Nothing was added. */
export class PlanNotSavedError extends Error {
  readonly code: "plan_not_saved" | "plan_too_big";
  readonly status: number;
  constructor(
    code: "plan_not_saved" | "plan_too_big",
    /** For the server log only. Never holds the file's bytes. */
    readonly reason: string,
  ) {
    super(code === "plan_too_big" ? PLAN_TOO_BIG_MESSAGE : PLAN_NOT_SAVED_MESSAGE);
    this.name = "PlanNotSavedError";
    this.code = code;
    this.status = code === "plan_too_big" ? 413 : 500;
  }
}

/** True for the errors above: each carries a status and a sentence to show. */
export function isPlanFileError(
  err: unknown,
): err is PlanFileGoneError | PlanFileRestoreError | PlanNotSavedError {
  return (
    err instanceof PlanFileGoneError ||
    err instanceof PlanFileRestoreError ||
    err instanceof PlanNotSavedError
  );
}

/**
 * A short reason for the log. The database layer's own error text repeats
 * every value of the failed statement, which here would be the whole file:
 * only the database's own short message is kept, never that text.
 */
function shortReason(err: unknown): string {
  const cause = (err as { cause?: unknown } | null)?.cause;
  const source = cause instanceof Error ? cause : err;
  const code = (source as { code?: unknown } | null)?.code;
  const text = source instanceof Error ? source.message : "unknown error";
  const clean = text.startsWith("Failed query") ? "the statement failed" : text;
  return (typeof code === "string" ? `${code}: ` : "") + clean.slice(0, 200);
}

// ---------------------------------------------------------------------------
// Storing
// ---------------------------------------------------------------------------

export interface NewPlanFile {
  jobId: number;
  /** The name the person gave the file. */
  fileName: string;
  fileType: string;
  buffer: Buffer;
}

/**
 * Add a plan to a job: the row and the bytes go into the database in ONE
 * transaction, so there is never a row without its bytes. The disk copy is
 * written first, as before; it is removed again if the database refuses.
 */
export async function storePlanFile(input: NewPlanFile): Promise<JobFile> {
  const { jobId, fileName, fileType, buffer } = input;
  if (buffer.length > MAX_PLAN_FILE_BYTES) {
    throw new PlanNotSavedError("plan_too_big", `${buffer.length} bytes`);
  }

  const fileHash = createHash("sha256").update(buffer).digest("hex");
  const jobDir = path.join(UPLOAD_DIR, String(jobId));
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = path.join(jobDir, `${Date.now()}_${safeName}`);

  try {
    await mkdir(jobDir, { recursive: true });
    await writeFile(filePath, buffer);
  } catch (err) {
    await unlink(filePath).catch(() => {});
    throw new PlanNotSavedError("plan_not_saved", `disk: ${shortReason(err)}`);
  }

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(jobFilesTable)
        .values({
          jobId,
          fileName,
          filePath,
          fileHash,
          fileType,
          fileSize: buffer.length,
        })
        .returning();
      if (!row) throw new Error("the file row was not created");
      await tx.insert(jobFileBlobsTable).values({
        fileId: row.id,
        data: buffer,
        sizeBytes: buffer.length,
      });
      return row;
    });
  } catch (err) {
    // The transaction rolled back: no row, no bytes. Do not leave the disk
    // copy behind either.
    await unlink(filePath).catch(() => {});
    throw new PlanNotSavedError("plan_not_saved", `database: ${shortReason(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** What a reader has to hand over: the row, or the parts of it used here. */
export type PlanFileRef = Pick<JobFile, "id" | "filePath"> &
  Partial<Pick<JobFile, "fileName" | "fileHash">>;

async function isFileOnDisk(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

// One restore per file at a time in this process: a second request for the
// same missing file waits for the first instead of writing beside it.
const restoring = new Map<number, Promise<string>>();

/**
 * The path of a plan's file on this server's disk, ready to open.
 *
 * On the disk already: that path. Not on the disk: brought back from the
 * database first. Neither: PlanFileGoneError (410, "upload it again").
 */
export async function planFilePath(file: PlanFileRef): Promise<string> {
  if (await isFileOnDisk(file.filePath)) return file.filePath;

  let pending = restoring.get(file.id);
  if (!pending) {
    pending = restoreFromDatabase(file).finally(() => {
      restoring.delete(file.id);
    });
    restoring.set(file.id, pending);
  }
  return pending;
}

async function restoreFromDatabase(file: PlanFileRef): Promise<string> {
  const client = await pool.connect();
  let tempPath: string | null = null;
  try {
    const head = await client.query<{ size_bytes: number; stored: number }>(
      "SELECT size_bytes, octet_length(data) AS stored FROM job_file_blobs WHERE file_id = $1",
      [file.id],
    );
    const found = head.rows[0];
    if (!found) throw new PlanFileGoneError(file.id, file.fileName ?? null);
    const expected = found.size_bytes;
    if (found.stored !== expected) {
      throw new PlanFileRestoreError(
        file.id,
        `the database holds ${found.stored} bytes, the row says ${expected}`,
      );
    }

    // Written under a name of its own and only then given the real name, so
    // a reader never sees half a file and two writers never share one.
    await mkdir(path.dirname(file.filePath), { recursive: true });
    tempPath = `${file.filePath}.${process.pid}.${randomUUID()}.part`;
    const hash = createHash("sha256");
    let written = 0;
    const handle = await open(tempPath, "wx");
    try {
      for (let offset = 0; offset < expected; offset += RESTORE_PIECE_BYTES) {
        const piece = await client.query<{ piece: Buffer | null }>(
          "SELECT substring(data FROM $1::int FOR $2::int) AS piece FROM job_file_blobs WHERE file_id = $3",
          [offset + 1, RESTORE_PIECE_BYTES, file.id],
        );
        const row = piece.rows[0];
        // The file was deleted while it was being brought back.
        if (!row) throw new PlanFileGoneError(file.id, file.fileName ?? null);
        const bytes = row.piece;
        if (!bytes || bytes.length === 0) break;
        let done = 0;
        while (done < bytes.length) {
          const { bytesWritten } = await handle.write(bytes, done, bytes.length - done);
          done += bytesWritten;
        }
        hash.update(bytes);
        written += bytes.length;
      }
    } finally {
      await handle.close();
    }

    const onDisk = (await stat(tempPath)).size;
    if (written !== expected || onDisk !== expected) {
      throw new PlanFileRestoreError(
        file.id,
        `wrote ${written} bytes (${onDisk} on the disk), expected ${expected}`,
      );
    }
    // The row's hash was taken from the same bytes when they were stored.
    if (
      typeof file.fileHash === "string" &&
      /^[0-9a-f]{64}$/.test(file.fileHash) &&
      hash.digest("hex") !== file.fileHash
    ) {
      throw new PlanFileRestoreError(file.id, "the bytes do not match the file's hash");
    }

    try {
      await rename(tempPath, file.filePath);
    } catch (err) {
      // Another server process on the same disk put the file back first.
      const there = await stat(file.filePath).catch(() => null);
      if (!there || !there.isFile() || there.size !== expected) throw err;
    }
    tempPath = null;

    logger.info(
      { fileId: file.id, bytes: expected },
      "Plan file brought back from the database (it was missing on the disk)",
    );
    return file.filePath;
  } catch (err) {
    if (err instanceof PlanFileGoneError) {
      logger.warn(
        { fileId: file.id },
        "Plan file is gone: not on the disk and no bytes in the database",
      );
      throw err;
    }
    if (err instanceof PlanFileRestoreError) {
      logger.error({ fileId: file.id, reason: err.reason }, "Plan file could not be brought back");
      throw err;
    }
    const reason = shortReason(err);
    logger.error({ fileId: file.id, reason }, "Plan file could not be brought back");
    throw new PlanFileRestoreError(file.id, reason);
  } finally {
    client.release();
    if (tempPath) await unlink(tempPath).catch(() => {});
  }
}

/** The JSON body for one of the errors above. */
export function planFileErrorBody(
  err: PlanFileGoneError | PlanFileRestoreError | PlanNotSavedError,
): Record<string, unknown> {
  const body: Record<string, unknown> = { code: err.code, message: err.message };
  if (err instanceof PlanFileGoneError) {
    body.fileId = err.fileId;
    if (err.fileName) body.fileName = err.fileName;
  }
  return body;
}

/**
 * Remove the working copy of a plan whose row was just deleted (its bytes
 * went with the row: job_file_blobs cascades). Missing is fine.
 */
export async function removeDiskCopy(file: PlanFileRef): Promise<void> {
  await unlink(file.filePath).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") {
      logger.warn({ code: err.code, fileId: file.id }, "Failed to remove a plan's disk copy");
    }
  });
}
