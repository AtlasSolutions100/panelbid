/**
 * A failure says why, in one plain sentence, with a status that fits.
 *
 * Room reading (POST /jobs/:id/extract-specs), the price-sheet reader, the
 * keyword scan and the upload, over HTTP against the real routes, signed
 * in, on a REAL PostgreSQL (see test/realDatabase.ts: a throwaway database
 * on this computer only). The AI reader and the two PDF programs are
 * stand-ins that fail the way a test tells them to; a MISSING program is
 * made by pointing its name at something that does not exist.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import path from "node:path";
import { signIn, startApp, type Running } from "./test/harness";
import {
  binaryPlan,
  makeUploadDir,
  readTestDatabase,
  textPlan,
  uploadPlan,
} from "./test/realDatabase";

const SENTENCES = {
  gone: "This plan's file is no longer on the server. Upload it again.",
  noPlan: "Add a plan first.",
  noSchedule:
    'No page in these plans looks like a finish schedule. The app looks for a page with the words "Finish Schedule" or "Finish Legend", or a room table with your keywords on it. You can add the rooms by hand with Add Row.',
  noText:
    "This plan has no text the app can read (it is probably a scan), so the finish schedule cannot be found in it. You can add the rooms by hand with Add Row.",
  unreadable: "This plan's PDF could not be opened. Save it again as a PDF and upload it again.",
  aiNoAnswer: "The AI reader did not answer. Try again in a few minutes.",
  aiRefused: "The AI reader refused the request. Try again later; if it keeps happening, tell support.",
  aiTooSlow: "The AI reader took too long to answer. Try again.",
  aiBadAnswer: "The AI reader's answer could not be understood. Try again.",
  noPicture:
    "A page of this plan could not be turned into a picture. Save the plan again as a PDF and upload it again.",
  toolsMissing: "This server is missing its PDF tools, so plans can't be read yet. Tell support.",
  running: "Room reading is already running for this job. Wait for it to finish.",
  notAPdf: "That file is not a PDF. Plans must be PDF files.",
  noFile: "No file arrived. Choose a PDF and upload it again.",
  badRequest: "The request could not be read. Reload the page and try again.",
};

// The AI reader: answers, or fails, the way a test tells it to.
const ai = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: { messages: { create: (...args: unknown[]) => ai.create(...args) } },
}));

// pdfinfo and pdftoppm. "there": they answer like the real ones. "missing":
// their name points at a program that does not exist (a true ENOENT from the
// operating system). "vanished": found when looked for, gone when used.
const programs = vi.hoisted(() => ({
  state: "there" as "there" | "missing" | "vanished",
  pdftoppmFails: false,
  /** Every start that was not the "-v" look. */
  uses: [] as string[],
}));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const { writeFile } = await import("node:fs/promises");
  const realRun = promisify(real.execFile);
  const NOT_THERE = "panelbid-test-no-such-program";
  const standIn = async (file: string, args: string[]) => {
    if (file !== "pdfinfo" && file !== "pdftoppm") return realRun(file, args);
    const looking = args.length === 1 && args[0] === "-v";
    if (!looking) programs.uses.push(file);
    if (programs.state === "missing" || (programs.state === "vanished" && !looking)) {
      return realRun(NOT_THERE, args); // rejects with the real "spawn ... ENOENT"
    }
    if (looking) return { stdout: "", stderr: `${file} version 24.02.0\n` };
    if (file === "pdfinfo") {
      return {
        stdout: "Pages:          3\nPage    1 size: 612 x 792 pts (letter)\nPage    1 rot:  0\n",
        stderr: "",
      };
    }
    if (programs.pdftoppmFails) {
      throw Object.assign(new Error("Command failed: pdftoppm\nSyntax Error: Couldn't read xref table"), {
        code: 1,
      });
    }
    await writeFile(`${args[args.length - 1]}-1.jpg`, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    return { stdout: "", stderr: "" };
  };
  const execFile = Object.assign(
    () => {
      throw new Error("the stand-in only knows the promise form of execFile");
    },
    { [promisify.custom]: standIn },
  );
  return { ...real, execFile, default: { ...real, execFile } };
});

function aiAnswer(rooms: unknown[]) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          page_type: "finish_schedule",
          rooms,
          material_key: [],
          fire_rating_present_anywhere: false,
        }),
      },
    ],
  };
}
const ROOM = {
  room_name: "KITCHEN",
  room_number: "101",
  material_category: "frp",
  material_height: null,
  manufacturer: null,
  color: null,
  product_code: null,
  texture: null,
  fire_rating: null,
};
// Errors shaped like the AI provider's own (told apart by kind and status).
class APIConnectionError extends Error {}
class APIConnectionTimeoutError extends APIConnectionError {}

const database = readTestDatabase();
const haveDatabase = "url" in database;
if (!haveDatabase) {
  // Straight to the terminal: the test runner hides console lines from here.
  process.stderr.write(`\nSKIPPED, NOT RUN: the failure-sentence tests. ${database.skip}\n\n`);
}

describe.skipIf(!haveDatabase)("a failure says why, in one plain sentence", () => {
  let running: Running;
  let cookie: string;
  let uploadDir: string;
  let dbx: typeof import("@workspace/db");
  let store: typeof import("./lib/planFileStore");
  let pdfTools: typeof import("./lib/pdfTools");
  const jobIds: number[] = [];

  const post = (urlPath: string, body?: unknown) =>
    running.call("POST", urlPath, { cookie, body, headers: { origin: running.origin } });
  const get = (urlPath: string) => running.call("GET", urlPath, { cookie });

  async function makeJob(name: string): Promise<number> {
    const [job] = await dbx.db
      .insert(dbx.jobsTable)
      .values({ jobName: `__sentence_test__ ${name}`, address: "x", city: "x", status: "needs_review" })
      .returning();
    jobIds.push(job!.id);
    return job!.id;
  }

  /** A plan with its bytes, stored the way an upload stores it (no auto-scan). */
  async function addPlan(jobId: number, fileName: string, bytes: Buffer): Promise<number> {
    const row = await store.storePlanFile({ jobId, fileName, fileType: "application/pdf", buffer: bytes });
    return row.id;
  }

  /** A row like the live site's lost plans: no file on the disk, no bytes. */
  async function lostPlan(jobId: number): Promise<number> {
    const [file] = await dbx.db
      .insert(dbx.jobFilesTable)
      .values({
        jobId,
        fileName: "lost-plan.pdf",
        filePath: path.join(uploadDir, String(jobId), "1700000000000_lost-plan.pdf"),
        fileHash: "0".repeat(64),
        fileType: "application/pdf",
        fileSize: 4321,
      })
      .returning();
    return file!.id;
  }

  const schedulePlan = (pages = 1) =>
    textPlan(Array.from({ length: pages }, (_, i) => `ROOM FINISH SCHEDULE sheet ${i + 1}`));

  async function roomCount(jobId: number): Promise<number> {
    const { rows } = await dbx.pool.query("SELECT count(*)::int AS n FROM room_specs WHERE job_id = $1", [jobId]);
    return rows[0].n as number;
  }

  /** The reply is the status and one sentence: nothing of what really happened. */
  function expectPlainWords(text: string) {
    expect(text).not.toMatch(/ENOENT|EACCES|spawn|stack|\bat \w+ \(|node_modules|Failed query/);
    expect(text).not.toContain(uploadDir);
    expect(text).not.toContain("uploads");
    expect(text).not.toMatch(/x-api-key|authentication_error|provider text|Connection error|xref/);
  }

  beforeAll(async () => {
    delete process.env.POPPLER_BIN_DIR;
    uploadDir = makeUploadDir();
    running = await startApp({ databaseUrl: (database as { url: string }).url, uploadDir });
    cookie = await signIn(running);
    dbx = await import("@workspace/db");
    store = await import("./lib/planFileStore");
    pdfTools = await import("./lib/pdfTools");
  });

  beforeEach(async () => {
    ai.create.mockReset();
    programs.state = "there";
    programs.pdftoppmFails = false;
    programs.uses.length = 0;
    // Only the stand-ins above can be found: nothing installed on this computer.
    pdfTools.resetPdfToolLookup({
      env: { PATH: "one" },
      usualPlaces: [],
      nixStore: path.join(uploadDir, "no-nix-store"),
    });
    const { aiPressLimiter } = await import("./middlewares/apiGate");
    aiPressLimiter.reset();
  });

  afterAll(async () => {
    if (!running) return;
    for (const id of jobIds) {
      await dbx.pool.query("DELETE FROM jobs WHERE id = $1", [id]);
    }
    await running.close();
    await dbx.pool.end();
    rmSync(uploadDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Room reading: nothing could be read
  // -------------------------------------------------------------------------

  it("the job has no plan: 422 'Add a plan first.'", async () => {
    const jobId = await makeJob("no plan");
    const reply = await post(`/api/jobs/${jobId}/extract-specs`);
    expect(reply.status).toBe(422);
    expect(reply.json).toEqual({ code: "no_plan", message: SENTENCES.noPlan });
  });

  it("no page looks like a finish schedule: 422, says what the app looks for and that rooms can be added by hand", async () => {
    const jobId = await makeJob("no schedule");
    await addPlan(jobId, "notes.pdf", textPlan(["GENERAL NOTES AND SYMBOLS", "SITE PLAN"]));
    const reply = await post(`/api/jobs/${jobId}/extract-specs`);
    expect(reply.status).toBe(422);
    expect(reply.json).toEqual({ code: "no_schedule_page", message: SENTENCES.noSchedule });
    expect(ai.create).not.toHaveBeenCalled();
  });

  it("a plan with no readable text (a scan): 422 and says so", async () => {
    const jobId = await makeJob("scan");
    await addPlan(jobId, "scanned.pdf", textPlan(["", ""]));
    const reply = await post(`/api/jobs/${jobId}/extract-specs`);
    expect(reply.status).toBe(422);
    expect(reply.json).toEqual({ code: "no_text", message: SENTENCES.noText });
  });

  it("a PDF that cannot be opened: 422 and says so", async () => {
    const jobId = await makeJob("damaged");
    await addPlan(jobId, "damaged.pdf", binaryPlan(4000));
    const reply = await post(`/api/jobs/${jobId}/extract-specs`);
    expect(reply.status).toBe(422);
    expect(reply.json).toEqual({ code: "plan_unreadable", message: SENTENCES.unreadable });
  });

  it.each([
    ["did not answer", () => new APIConnectionError("Connection error."), 502, "ai_no_answer", SENTENCES.aiNoAnswer],
    [
      "refused",
      () =>
        Object.assign(new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), {
          status: 401,
        }),
      502,
      "ai_refused",
      SENTENCES.aiRefused,
    ],
    ["was too slow", () => new APIConnectionTimeoutError("Request timed out."), 504, "ai_too_slow", SENTENCES.aiTooSlow],
  ])("the AI reader %s: says which, without its own text", async (_name, makeError, status, code, sentence) => {
    const jobId = await makeJob(`ai ${code}`);
    await addPlan(jobId, "rooms.pdf", schedulePlan(2));
    await dbx.db.insert(dbx.roomSpecsTable).values({ jobId, roomName: "TYPED BY HAND" });
    ai.create.mockRejectedValue(makeError());

    const reply = await post(`/api/jobs/${jobId}/extract-specs`);
    expect(reply.status).toBe(status);
    expect(reply.json).toEqual({ code, message: sentence });
    expectPlainWords(reply.text);
    expect(await roomCount(jobId)).toBe(1); // nothing already there was touched
  });

  it("the AI reader's answer cannot be read: 502 and says so", async () => {
    const jobId = await makeJob("bad answer");
    await addPlan(jobId, "rooms.pdf", schedulePlan());
    ai.create.mockResolvedValue({ content: [{ type: "text", text: "I'm sorry, I can't help with that." }] });
    const reply = await post(`/api/jobs/${jobId}/extract-specs`);
    expect(reply.status).toBe(502);
    expect(reply.json).toEqual({ code: "ai_bad_answer", message: SENTENCES.aiBadAnswer });
  });

  it("a page cannot be turned into a picture: 422 and says so (the AI reader is not asked)", async () => {
    const jobId = await makeJob("no picture");
    await addPlan(jobId, "rooms.pdf", schedulePlan());
    programs.pdftoppmFails = true;
    const reply = await post(`/api/jobs/${jobId}/extract-specs`);
    expect(reply.status).toBe(422);
    expect(reply.json).toEqual({ code: "page_not_rendered", message: SENTENCES.noPicture });
    expectPlainWords(reply.text);
    expect(ai.create).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // A missing PDF program is its own case
  // -------------------------------------------------------------------------

  it("the PDF programs are not on the server: both readers answer 503 with the sentence, never the raw text", async () => {
    const jobId = await makeJob("no tools");
    const fileId = await addPlan(jobId, "rooms.pdf", schedulePlan(3));
    programs.state = "missing";

    const rooms = await post(`/api/jobs/${jobId}/extract-specs`);
    expect(rooms.status).toBe(503);
    expect(rooms.json).toEqual({ code: "pdf_tools_missing", message: SENTENCES.toolsMissing });
    expectPlainWords(rooms.text);

    const prices = await post(`/api/files/${fileId}/extract-prices`);
    expect(prices.status).toBe(503);
    expect(prices.json).toEqual({ code: "pdf_tools_missing", message: SENTENCES.toolsMissing });
    expectPlainWords(prices.text);

    expect(ai.create).not.toHaveBeenCalled();
    expect(programs.uses).toEqual([]); // not found: nothing was even tried
  });

  it("a program gone when it is used: the room reader stops at the FIRST page (not '0 of 3')", async () => {
    const jobId = await makeJob("tools vanish");
    await addPlan(jobId, "rooms.pdf", schedulePlan(3));
    programs.state = "vanished";

    const reply = await post(`/api/jobs/${jobId}/extract-specs`);
    expect(reply.status).toBe(503);
    expect(reply.json).toEqual({ code: "pdf_tools_missing", message: SENTENCES.toolsMissing });
    expectPlainWords(reply.text);
    expect(programs.uses).toEqual(["pdfinfo"]); // one try, for page 1, then it stopped
    expect(ai.create).not.toHaveBeenCalled();
  });

  it("the price-sheet reader stores a sentence as its reason, never 'spawn pdfinfo ENOENT'", async () => {
    const jobId = await makeJob("price tools vanish");
    const fileId = await addPlan(jobId, "prices.pdf", textPlan(["PRICE SHEET"]));
    programs.state = "vanished"; // found at the start, gone when the pages are counted

    const start = await post(`/api/files/${fileId}/extract-prices`);
    expect(start.status).toBe(202);
    const { isPriceExtractionRunning } = await import("./lib/priceSheetExtractor");
    await vi.waitFor(() => expect(isPriceExtractionRunning(fileId)).toBe(false), { timeout: 10_000 });

    const status = await get(`/api/files/${fileId}/price-extraction`);
    expect(status.json).toMatchObject({ status: "failed", error: SENTENCES.toolsMissing });
    expectPlainWords(status.text);
    const stored = await dbx.pool.query("SELECT error FROM price_sheet_extractions WHERE job_file_id = $1", [fileId]);
    expect(stored.rows[0].error).toBe(SENTENCES.toolsMissing);
  });

  it("the price-sheet reader stores the AI reader's failure as a sentence too", async () => {
    const jobId = await makeJob("price ai refused");
    const fileId = await addPlan(jobId, "prices.pdf", textPlan(["PRICE SHEET"]));
    ai.create.mockRejectedValue(Object.assign(new Error("403 provider text"), { status: 403 }));

    const start = await post(`/api/files/${fileId}/extract-prices`);
    expect(start.status).toBe(202);
    const { isPriceExtractionRunning } = await import("./lib/priceSheetExtractor");
    await vi.waitFor(() => expect(isPriceExtractionRunning(fileId)).toBe(false), { timeout: 10_000 });

    const status = await get(`/api/files/${fileId}/price-extraction`);
    expect(status.json).toMatchObject({ status: "failed", error: SENTENCES.aiRefused });
    expectPlainWords(status.text);
  });

  // -------------------------------------------------------------------------
  // Room reading: some of it worked
  // -------------------------------------------------------------------------

  it("some pages read and some not: still a success with the counts, and the pages that failed are named", async () => {
    const jobId = await makeJob("partial");
    await addPlan(jobId, "A-601 finishes.pdf", schedulePlan(2));
    ai.create
      .mockResolvedValueOnce(aiAnswer([ROOM]))
      .mockRejectedValueOnce(new APIConnectionTimeoutError("Request timed out."));

    const reply = await post(`/api/jobs/${jobId}/extract-specs`);
    expect(reply.status, reply.text).toBe(200);
    expect(reply.json).toMatchObject({
      candidatePages: 2,
      pagesProcessed: 1,
      pagesFailed: 1,
      filesFailed: 0,
      roomsExtracted: 1,
      warning:
        "Not read: A-601 finishes.pdf page 2 (the AI reader took too long). Rows already there for that page were kept.",
    });
  });

  it("a lost plan beside one that is there: the one that is there is read, the lost one is named", async () => {
    const jobId = await makeJob("one gone, one there");
    await lostPlan(jobId);
    await addPlan(jobId, "rooms.pdf", schedulePlan());
    ai.create.mockResolvedValue(aiAnswer([ROOM]));

    const reply = await post(`/api/jobs/${jobId}/extract-specs`);
    expect(reply.status, reply.text).toBe(200);
    expect(reply.json).toMatchObject({
      pagesProcessed: 1,
      roomsExtracted: 1,
      filesFailed: 1,
      warning: "No longer on the server: lost-plan.pdf. Upload it again.",
    });

    const scan = await post(`/api/jobs/${jobId}/scan`);
    expect(scan.status, scan.text).toBe(200);
    expect(scan.json).toMatchObject({
      filesScanned: 1,
      warning: "Not scanned: lost-plan.pdf is no longer on the server. Upload it again.",
    });
  });

  it("a run with nothing left out carries no warning", async () => {
    const jobId = await makeJob("all read");
    await addPlan(jobId, "rooms.pdf", schedulePlan());
    ai.create.mockResolvedValue(aiAnswer([ROOM]));
    const reply = await post(`/api/jobs/${jobId}/extract-specs`);
    expect(reply.status, reply.text).toBe(200);
    expect(reply.json).not.toHaveProperty("warning");
    const scan = await post(`/api/jobs/${jobId}/scan`);
    expect(scan.json).not.toHaveProperty("warning");
  });

  // -------------------------------------------------------------------------
  // Pressing twice, pressing too often
  // -------------------------------------------------------------------------

  it("already running for this job: 409 and says so", async () => {
    const jobId = await makeJob("running");
    await addPlan(jobId, "rooms.pdf", schedulePlan());
    let finish: (answer: unknown) => void = () => undefined;
    ai.create.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));

    const first = post(`/api/jobs/${jobId}/extract-specs`);
    await vi.waitFor(() => expect(ai.create).toHaveBeenCalledTimes(1), { timeout: 10_000 });

    const second = await post(`/api/jobs/${jobId}/extract-specs`);
    expect(second.status).toBe(409);
    expect(second.json).toEqual({ code: "already_running", message: SENTENCES.running });

    finish(aiAnswer([ROOM]));
    expect((await first).status).toBe(200);
  });

  it("too many runs in a minute: 429 with the wait in words", async () => {
    const jobId = await makeJob("too often");
    for (let i = 0; i < 3; i++) {
      expect((await post(`/api/jobs/${jobId}/extract-specs`)).status).toBe(422);
    }
    const fourth = await post(`/api/jobs/${jobId}/extract-specs`);
    expect(fourth.status).toBe(429);
    expect(fourth.json!.code).toBe("ai_limit");
    expect(String(fourth.json!.message)).toMatch(
      /^The AI buttons can be pressed 3 times a minute and 20 times an hour, because every press costs money\. Try again in \d+ seconds\.$/,
    );
  });

  // -------------------------------------------------------------------------
  // Upload, and anything nobody planned for
  // -------------------------------------------------------------------------

  it("upload: not a PDF, and no file at all, each with its sentence", async () => {
    const jobId = await makeJob("upload words");
    const notPdf = await uploadPlan(running, cookie, jobId, "notes.txt", Buffer.from("hello"), "text/plain");
    expect(notPdf.status).toBe(415);
    expect(notPdf.json).toEqual({ code: "not_a_pdf", message: SENTENCES.notAPdf });

    const noFile = await post(`/api/jobs/${jobId}/files`, {});
    expect(noFile.status).toBe(400);
    expect(noFile.json).toEqual({ code: "no_file", message: SENTENCES.noFile });

    const { rows } = await dbx.pool.query("SELECT id FROM job_files WHERE job_id = $1", [jobId]);
    expect(rows).toEqual([]);
  });

  it("a request the server cannot read is answered in words, as JSON", async () => {
    const reply = await running.call("POST", "/api/jobs", {
      cookie,
      body: "{not json",
      headers: { origin: running.origin, "content-type": "application/json" },
    });
    expect(reply.status).toBe(400);
    expect(reply.json).toEqual({ code: "bad_request", message: SENTENCES.badRequest });
    expectPlainWords(reply.text);
  });
});
