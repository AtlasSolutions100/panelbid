/**
 * A plan file is kept in the database; the disk is only a copy.
 *
 * The host throws the server's disk away at every restart. These tests do
 * the same to a throwaway upload folder and then ask every reader for the
 * plan: view, download, keyword scan, room reading, price-sheet reading.
 *
 * Over HTTP against the real routes, signed in, on a REAL PostgreSQL (see
 * test/realDatabase.ts: a throwaway database on this computer only). The AI
 * reader and the two PDF programs are stand-ins; nothing leaves this
 * computer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { signIn, startApp, type Running } from "./test/harness";
import {
  binaryPlan,
  filesUnder,
  getBytes,
  makeUploadDir,
  readTestDatabase,
  textPlan,
  uploadPlan,
  wipeUploads,
} from "./test/realDatabase";

const GONE = "This plan's file is no longer on the server. Upload it again.";
const NOT_SAVED = "The plan could not be saved on the server, so nothing was added. Try again.";
const TOO_BIG = "This file is too big. The limit is 50 MB.";

// The AI reader: answers what a test tells it to.
const ai = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: { messages: { create: (...args: unknown[]) => ai.create(...args) } },
}));

// pdfinfo and pdftoppm (poppler): stand-ins that answer like the real ones,
// so the tests do not depend on what is installed on this computer.
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const { writeFile } = await import("node:fs/promises");
  const realRun = promisify(real.execFile);
  const standIn = async (file: string, args: string[]) => {
    if (file === "pdfinfo") {
      return {
        stdout: "Pages:          1\nPage    1 size: 612 x 792 pts (letter)\nPage    1 rot:  0\n",
        stderr: "",
      };
    }
    if (file === "pdftoppm") {
      await writeFile(`${args[args.length - 1]}-1.jpg`, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      return { stdout: "", stderr: "" };
    }
    return realRun(file, args);
  };
  const execFile = Object.assign(
    () => {
      throw new Error("the stand-in only knows the promise form of execFile");
    },
    { [promisify.custom]: standIn },
  );
  return { ...real, execFile, default: { ...real, execFile } };
});

const database = readTestDatabase();
const haveDatabase = "url" in database;
if (!haveDatabase) {
  console.warn(`\nSKIPPED, NOT RUN: the plan file store tests. ${database.skip}\n`);
}

type Db = typeof import("@workspace/db");

describe.skipIf(!haveDatabase)("a plan file is kept in the database", () => {
  let running: Running;
  let cookie: string;
  let uploadDir: string;
  let dbx: Db;
  const jobIds: number[] = [];
  const keywordIds: number[] = [];

  const post = (urlPath: string) =>
    running.call("POST", urlPath, { cookie, headers: { origin: running.origin } });
  const del = (urlPath: string) =>
    running.call("DELETE", urlPath, { cookie, headers: { origin: running.origin } });

  async function makeJob(name: string): Promise<number> {
    const [job] = await dbx.db
      .insert(dbx.jobsTable)
      .values({ jobName: `__store_test__ ${name}`, address: "x", city: "x", status: "needs_review" })
      .returning();
    jobIds.push(job!.id);
    return job!.id;
  }

  async function blobOf(fileId: number) {
    const { rows } = await dbx.pool.query(
      "SELECT size_bytes, octet_length(data) AS stored, data FROM job_file_blobs WHERE file_id = $1",
      [fileId],
    );
    return rows[0] as { size_bytes: number; stored: number; data: Buffer } | undefined;
  }

  async function rowOf(fileId: number) {
    const { rows } = await dbx.pool.query(
      "SELECT id, job_id, file_path, file_hash, file_size, needs_ocr FROM job_files WHERE id = $1",
      [fileId],
    );
    return rows[0] as
      | { id: number; job_id: number; file_path: string; file_hash: string; file_size: number; needs_ocr: boolean }
      | undefined;
  }

  /** Upload and return the new file's id and where its disk copy is. */
  async function upload(jobId: number, name: string, bytes: Buffer) {
    const reply = await uploadPlan(running, cookie, jobId, name, bytes);
    expect(reply.status, JSON.stringify(reply.json)).toBe(201);
    const id = reply.json!.id as number;
    const row = await rowOf(id);
    return { id, filePath: row!.file_path };
  }

  /** A row like the live site's lost plans: no file on the disk, no bytes. */
  async function lostPlan(jobId: number, needsOcr = false): Promise<number> {
    const [file] = await dbx.db
      .insert(dbx.jobFilesTable)
      .values({
        jobId,
        fileName: "lost-plan.pdf",
        filePath: path.join(uploadDir, String(jobId), "1700000000000_lost-plan.pdf"),
        fileHash: "0".repeat(64),
        fileType: "application/pdf",
        fileSize: 4321,
        needsOcr,
      })
      .returning();
    return file!.id;
  }

  beforeAll(async () => {
    delete process.env.POPPLER_BIN_DIR; // only the stand-ins above are found
    uploadDir = makeUploadDir();
    running = await startApp({ databaseUrl: (database as { url: string }).url, uploadDir });
    cookie = await signIn(running);
    dbx = await import("@workspace/db");
  });

  beforeEach(async () => {
    ai.create.mockReset();
    const { aiPressLimiter } = await import("./middlewares/apiGate");
    aiPressLimiter.reset();
  });

  afterAll(async () => {
    if (!running) return;
    for (const id of jobIds) {
      await dbx.pool.query("DELETE FROM jobs WHERE id = $1", [id]);
    }
    for (const id of keywordIds) {
      await dbx.pool.query("DELETE FROM keywords WHERE id = $1", [id]);
    }
    await running.close();
    await dbx.pool.end();
    rmSync(uploadDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  it("an upload stores the row and its bytes, and the disk copy as before", async () => {
    const jobId = await makeJob("upload");
    const bytes = binaryPlan(300_000);
    const { id, filePath } = await upload(jobId, "A-101 plan.pdf", bytes);

    const blob = await blobOf(id);
    expect(blob, "no bytes were stored for the uploaded file").toBeDefined();
    expect(blob!.size_bytes).toBe(bytes.length);
    expect(blob!.stored).toBe(bytes.length);
    expect(blob!.data.equals(bytes)).toBe(true);

    const row = await rowOf(id);
    expect(row!.file_size).toBe(bytes.length);
    expect(row!.file_hash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(readFileSync(filePath).equals(bytes)).toBe(true);
  });

  it("the list of a job's files does not carry the bytes", async () => {
    const jobId = await makeJob("list");
    await upload(jobId, "list.pdf", binaryPlan(50_000));
    const reply = await running.call("GET", `/api/jobs/${jobId}/files`, { cookie });
    expect(reply.status).toBe(200);
    expect(reply.text.length).toBeLessThan(2_000);
    expect(reply.text).not.toContain('"data"');
  });

  it("when the bytes cannot be stored the upload fails in words and leaves nothing behind", async () => {
    const jobId = await makeJob("refused");
    // The database refuses the bytes of one file of an odd size (this test's only).
    await dbx.pool.query(`
      CREATE OR REPLACE FUNCTION pb_store_test_refuse() RETURNS trigger AS $$
      BEGIN
        IF NEW.size_bytes = 31337 THEN RAISE EXCEPTION 'store test: bytes refused'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await dbx.pool.query("DROP TRIGGER IF EXISTS pb_store_test_refuse ON job_file_blobs");
    await dbx.pool.query(
      "CREATE TRIGGER pb_store_test_refuse BEFORE INSERT ON job_file_blobs FOR EACH ROW EXECUTE FUNCTION pb_store_test_refuse()",
    );
    try {
      const reply = await uploadPlan(running, cookie, jobId, "refused.pdf", binaryPlan(31337));
      expect(reply.status).toBe(500);
      expect(reply.json).toMatchObject({ code: "plan_not_saved", message: NOT_SAVED });

      const { rows } = await dbx.pool.query("SELECT id FROM job_files WHERE job_id = $1", [jobId]);
      expect(rows, "a file row was left behind without its bytes").toEqual([]);
      expect(filesUnder(path.join(uploadDir, String(jobId)))).toEqual([]);

      // What goes to the log is short and never the file itself.
      const { storePlanFile } = await import("./lib/planFileStore");
      const failure = await storePlanFile({
        jobId,
        fileName: "refused.pdf",
        fileType: "application/pdf",
        buffer: binaryPlan(31337),
      }).then(
        () => null,
        (err: unknown) => err as Error & { reason?: string },
      );
      expect(failure).not.toBeNull();
      expect(failure!.message).toBe(NOT_SAVED);
      expect(failure!.reason).toContain("store test: bytes refused");
      expect(failure!.reason!.length).toBeLessThan(300);
      expect((failure as { cause?: unknown }).cause).toBeUndefined();
    } finally {
      await dbx.pool.query("DROP TRIGGER IF EXISTS pb_store_test_refuse ON job_file_blobs");
      await dbx.pool.query("DROP FUNCTION IF EXISTS pb_store_test_refuse()");
    }
  });

  it("a file over 50 MB is refused with the limit in words", async () => {
    const jobId = await makeJob("too big");
    const reply = await uploadPlan(running, cookie, jobId, "huge.pdf", binaryPlan(50 * 1024 * 1024 + 1));
    expect(reply.status).toBe(413);
    expect(reply.json).toMatchObject({ code: "plan_too_big", message: TOO_BIG });
    const { rows } = await dbx.pool.query("SELECT id FROM job_files WHERE job_id = $1", [jobId]);
    expect(rows).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Reading: the disk copy is gone, the bytes come back
  // -------------------------------------------------------------------------

  it("view brings a lost disk copy back, byte for byte", async () => {
    const jobId = await makeJob("view");
    const bytes = binaryPlan(9_000_000, 11); // more than one 4 MB piece
    const { id, filePath } = await upload(jobId, "view.pdf", bytes);

    wipeUploads(uploadDir);
    expect(existsSync(filePath)).toBe(false);

    const reply = await getBytes(running, cookie, `/api/files/${id}/view`);
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toContain("application/pdf");
    expect(reply.body.equals(bytes)).toBe(true);
    expect(readFileSync(filePath).equals(bytes)).toBe(true);
    // No half-written file is left beside it.
    expect(filesUnder(path.join(uploadDir, String(jobId)))).toEqual([path.basename(filePath)]);
  });

  it("download brings a lost disk copy back, byte for byte", async () => {
    const jobId = await makeJob("download");
    const bytes = binaryPlan(120_000, 3);
    const { id, filePath } = await upload(jobId, "download.pdf", bytes);

    wipeUploads(uploadDir);
    const reply = await getBytes(running, cookie, `/api/files/${id}/download`);
    expect(reply.status).toBe(200);
    expect(reply.headers["content-disposition"]).toContain("download.pdf");
    expect(reply.body.equals(bytes)).toBe(true);
    expect(readFileSync(filePath).equals(bytes)).toBe(true);
  });

  it("the keyword scan brings a lost disk copy back and reads it", async () => {
    const jobId = await makeJob("scan");
    const word = `zzstore${Date.now()}`;
    const { rows } = await dbx.pool.query(
      "INSERT INTO keywords (term, category, active) VALUES ($1, 'frp', true) RETURNING id",
      [word],
    );
    keywordIds.push(rows[0].id as number);
    const bytes = textPlan([`GENERAL NOTES ${word} wall panels`]);
    const { id, filePath } = await upload(jobId, "scan.pdf", bytes);

    wipeUploads(uploadDir);
    const reply = await post(`/api/jobs/${jobId}/scan`);
    expect(reply.status, reply.text).toBe(200);
    expect(reply.json).toMatchObject({ filesScanned: 1, filesNeedingOcr: 0 });
    expect(reply.json!.matchCount).toBeGreaterThanOrEqual(1);
    expect(readFileSync(filePath).equals(bytes)).toBe(true);

    const hits = await dbx.pool.query(
      "SELECT count(*)::int AS n FROM plan_scans WHERE file_id = $1 AND term = $2",
      [id, word],
    );
    expect(hits.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("room reading brings a lost disk copy back and reads it", async () => {
    const jobId = await makeJob("rooms");
    const bytes = textPlan(["ROOM FINISH SCHEDULE sheet A-601"]);
    const { id, filePath } = await upload(jobId, "rooms.pdf", bytes);
    ai.create.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            page_type: "finish_schedule",
            rooms: [
              {
                room_name: "KITCHEN",
                room_number: "101",
                material_category: "frp",
                material_height: null,
                manufacturer: null,
                color: null,
                product_code: null,
                texture: null,
                fire_rating: null,
              },
            ],
            material_key: [],
            fire_rating_present_anywhere: false,
          }),
        },
      ],
    });

    wipeUploads(uploadDir);
    const reply = await post(`/api/jobs/${jobId}/extract-specs`);
    expect(reply.status, reply.text).toBe(200);
    expect(reply.json).toMatchObject({ candidatePages: 1, pagesProcessed: 1, roomsExtracted: 1 });
    expect(readFileSync(filePath).equals(bytes)).toBe(true);

    const rooms = await dbx.pool.query(
      "SELECT room_name FROM room_specs WHERE job_id = $1 AND source_file_id = $2",
      [jobId, id],
    );
    expect(rooms.rows.map((r) => r.room_name)).toEqual(["KITCHEN"]);
  });

  it("the price-sheet reader's start brings a lost disk copy back", async () => {
    const jobId = await makeJob("prices");
    const bytes = textPlan(["PRICE SHEET"]);
    const { id, filePath } = await upload(jobId, "prices.pdf", bytes);
    ai.create.mockResolvedValue({ content: [{ type: "text", text: '{"items":[]}' }] });

    wipeUploads(uploadDir);
    const reply = await post(`/api/files/${id}/extract-prices`);
    expect(reply.status, reply.text).toBe(202);
    expect(readFileSync(filePath).equals(bytes)).toBe(true);

    // Let the reading that runs after the answer finish before the next test.
    const { isPriceExtractionRunning } = await import("./lib/priceSheetExtractor");
    await vi.waitFor(() => expect(isPriceExtractionRunning(id)).toBe(false), { timeout: 10_000 });
  });

  it("requests for the same lost file at the same time all get the whole file", async () => {
    const jobId = await makeJob("together");
    const bytes = binaryPlan(6_000_000, 23);
    const { id, filePath } = await upload(jobId, "together.pdf", bytes);

    wipeUploads(uploadDir);
    const replies = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        getBytes(running, cookie, `/api/files/${id}/${i % 2 === 0 ? "view" : "download"}`),
      ),
    );
    for (const reply of replies) {
      expect(reply.status).toBe(200);
      expect(reply.body.equals(bytes)).toBe(true);
    }
    expect(filesUnder(path.join(uploadDir, String(jobId)))).toEqual([path.basename(filePath)]);
    expect(readFileSync(filePath).equals(bytes)).toBe(true);
  });

  it("a file that is on the disk is used as it is (plans from before have no bytes)", async () => {
    const jobId = await makeJob("on disk only");
    const { id, filePath } = await upload(jobId, "old.pdf", binaryPlan(40_000, 5));
    await dbx.pool.query("DELETE FROM job_file_blobs WHERE file_id = $1", [id]);

    const reply = await getBytes(running, cookie, `/api/files/${id}/view`);
    expect(reply.status).toBe(200);
    expect(reply.body.equals(readFileSync(filePath))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Reading: no file and no bytes
  // -------------------------------------------------------------------------

  it("no file and no bytes: every reader answers 410 with the same sentence", async () => {
    const jobId = await makeJob("gone");
    const fileId = await lostPlan(jobId);

    const view = await getBytes(running, cookie, `/api/files/${fileId}/view`);
    expect(view.status).toBe(410);
    expect(view.json).toMatchObject({ code: "plan_file_gone", message: GONE });

    const download = await getBytes(running, cookie, `/api/files/${fileId}/download`);
    expect(download.status).toBe(410);
    expect(download.json).toMatchObject({ code: "plan_file_gone", message: GONE });

    const scan = await post(`/api/jobs/${jobId}/scan`);
    expect(scan.status).toBe(410);
    expect(scan.json).toMatchObject({ code: "plan_file_gone", message: GONE, fileName: "lost-plan.pdf" });

    const rooms = await post(`/api/jobs/${jobId}/extract-specs`);
    expect(rooms.status).toBe(410);
    expect(rooms.json).toMatchObject({ code: "plan_file_gone", message: GONE, fileName: "lost-plan.pdf" });

    const prices = await post(`/api/files/${fileId}/extract-prices`);
    expect(prices.status).toBe(410);
    expect(prices.json).toMatchObject({ code: "plan_file_gone", message: GONE });

    // Nothing was said about pages nobody has seen, and no path was shown.
    expect((await rowOf(fileId))!.needs_ocr).toBe(false);
    for (const reply of [view.body.toString("utf8"), download.body.toString("utf8"), scan.text, rooms.text, prices.text]) {
      expect(reply).not.toContain("uploads");
      expect(reply).not.toContain(uploadDir);
      expect(reply).not.toMatch(/ENOENT|stack|at \w+ \(/);
    }
    expect(ai.create).not.toHaveBeenCalled();
  });

  it("a lost plan once marked 'needs OCR' is still reported as gone, not as a scan", async () => {
    const jobId = await makeJob("gone and marked");
    await lostPlan(jobId, true);
    const rooms = await post(`/api/jobs/${jobId}/extract-specs`);
    expect(rooms.status).toBe(410);
    expect(rooms.json).toMatchObject({ message: GONE });
  });

  it("a lost plan beside one that is there: the one that is there is still scanned", async () => {
    const jobId = await makeJob("one gone, one there");
    const lostId = await lostPlan(jobId);
    await upload(jobId, "there.pdf", textPlan(["GENERAL NOTES"]));

    const scan = await post(`/api/jobs/${jobId}/scan`);
    expect(scan.status, scan.text).toBe(200);
    expect(scan.json).toMatchObject({ filesScanned: 1 });
    expect((await rowOf(lostId))!.needs_ocr).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Deleting
  // -------------------------------------------------------------------------

  it("deleting a file removes its bytes too", async () => {
    const jobId = await makeJob("delete file");
    const { id, filePath } = await upload(jobId, "delete-me.pdf", binaryPlan(70_000));
    expect(await blobOf(id)).toBeDefined();

    const reply = await del(`/api/files/${id}`);
    expect(reply.status).toBe(204);
    expect(await blobOf(id)).toBeUndefined();
    expect(await rowOf(id)).toBeUndefined();
    expect(existsSync(filePath)).toBe(false);
  });

  it("deleting a job removes the bytes of all its files", async () => {
    const jobId = await makeJob("delete job");
    const a = await upload(jobId, "a.pdf", binaryPlan(60_000, 1));
    const b = await upload(jobId, "b.pdf", binaryPlan(60_000, 2));
    const before = await dbx.pool.query(
      "SELECT count(*)::int AS n FROM job_file_blobs WHERE file_id = ANY($1)",
      [[a.id, b.id]],
    );
    expect(before.rows[0].n).toBe(2);

    const reply = await del(`/api/jobs/${jobId}`);
    expect(reply.status).toBe(204);
    const after = await dbx.pool.query(
      "SELECT count(*)::int AS n FROM job_file_blobs WHERE file_id = ANY($1)",
      [[a.id, b.id]],
    );
    expect(after.rows[0].n).toBe(0);
  });

  // -------------------------------------------------------------------------
  // The table itself
  // -------------------------------------------------------------------------

  it("the start-up migration can run twice and makes the same table as the schema file", async () => {
    const { ensureJobFileBlobsTable } = await import("./lib/fileStoreMigrations");
    const scratch = `pb_store_migration_${process.pid}_${Date.now()}`;
    const client = await dbx.pool.connect();

    const describeTable = async (schema: string) => {
      await client.query(`SET search_path TO ${schema}`);
      const columns = await client.query(
        `SELECT column_name, data_type, udt_name, is_nullable, coalesce(column_default, '') AS column_default
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'job_file_blobs'
          ORDER BY ordinal_position`,
        [schema],
      );
      const constraints = await client.query(
        `SELECT c.conname, c.contype, c.confdeltype, c.confupdtype, pg_get_constraintdef(c.oid) AS def
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = $1 AND t.relname = 'job_file_blobs'
          ORDER BY c.conname`,
        [schema],
      );
      const indexes = await client.query(
        `SELECT indexname, replace(indexdef, $1 || '.', '') AS def
           FROM pg_indexes WHERE schemaname = $1 AND tablename = 'job_file_blobs'
          ORDER BY indexname`,
        [schema],
      );
      return { columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows };
    };

    try {
      await client.query(`CREATE SCHEMA ${scratch}`);
      await client.query(`SET search_path TO ${scratch}`);
      await client.query("CREATE TABLE job_files (id SERIAL PRIMARY KEY)");

      await ensureJobFileBlobsTable(client);
      await ensureJobFileBlobsTable(client); // a second start changes nothing and does not fail

      const made = await describeTable(scratch);
      const fromSchemaFile = await describeTable("public");

      expect(made.columns.map((c) => c.column_name)).toEqual(["file_id", "data", "size_bytes", "created_at"]);
      expect(made.columns.find((c) => c.column_name === "data")).toMatchObject({ udt_name: "bytea", is_nullable: "NO" });
      const foreignKey = made.constraints.find((c) => c.contype === "f");
      expect(foreignKey).toMatchObject({
        conname: "job_file_blobs_file_id_job_files_id_fk",
        confdeltype: "c", // ON DELETE CASCADE
        def: "FOREIGN KEY (file_id) REFERENCES job_files(id) ON DELETE CASCADE",
      });
      // The table the server makes at start-up IS the table of the schema file.
      expect(made).toEqual(fromSchemaFile);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${scratch} CASCADE`).catch(() => {});
      // This connection had its search path changed: do not hand it back.
      client.release(true);
    }
  });
});
