/**
 * Finding and starting the two PDF programs (pdfinfo, pdftoppm), the words
 * for when they are not on the server, and the signed-in check the page
 * shows on Settings.
 *
 * No database and no outside service. The lookup is given a made-up world
 * (folders created for the test, a made-up answer to "can this be
 * started?"), so the result does not depend on what this computer has.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { signIn, startApp, type Running } from "../test/harness";

let running: Running;
let pdf: typeof import("./pdfTools");
let failures: typeof import("./readingFailures");
let logger: typeof import("./logger").logger;

const root = mkdtempSync(path.join(tmpdir(), "panelbid-test-pdftools-"));
const envDir = path.join(root, "from-env");
const placeA = path.join(root, "usr-bin");
const placeB = path.join(root, "usr-local-bin");
const nixStore = path.join(root, "nix-store");
const nixPoppler = path.join(nixStore, "abc123-poppler-utils-24.02.0", "bin");
const nixDecoy = path.join(nixStore, "def456-poppler-data-0.4.12", "bin");
const NOWHERE = path.join(root, "not-there");

/** A made-up world: `startable` is every command that "can be started". */
function worldWith(startable: string[], env: Record<string, string | undefined> = {}) {
  const asked: string[] = [];
  const can = new Set(startable);
  return {
    asked,
    world: {
      env: { PATH: ["one", "two", "three"].join(path.delimiter), ...env },
      usualPlaces: [placeA, placeB],
      nixStore,
      canStart: async (command: string) => {
        asked.push(command);
        return can.has(command);
      },
    },
  };
}

beforeAll(async () => {
  for (const dir of [envDir, placeA, placeB, nixPoppler, nixDecoy, path.join(nixStore, "ghi789-replit-runtime-path", "bin")]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path.join(nixStore, "a-file-not-a-folder-poppler-utils.drv"), "");
  running = await startApp();
  pdf = await import("./pdfTools");
  failures = await import("./readingFailures");
  ({ logger } = await import("./logger"));
});

afterEach(() => {
  pdf.resetPdfToolLookup();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await running.close();
  rmSync(root, { recursive: true, force: true });
});

describe("finding the PDF programs: the order", () => {
  it("1. the folder named by POPPLER_BIN_DIR wins, and the program is started by its full path", async () => {
    const everywhere = [
      path.join(envDir, "pdfinfo"), path.join(envDir, "pdftoppm"),
      "pdfinfo", "pdftoppm",
      path.join(placeA, "pdfinfo"), path.join(placeA, "pdftoppm"),
    ];
    const { world } = worldWith(everywhere, { POPPLER_BIN_DIR: envDir });
    pdf.resetPdfToolLookup(world);
    const found = await pdf.findPdfTools();
    expect(found.tools.pdfinfo).toEqual({ how: "env", command: path.join(envDir, "pdfinfo") });
    expect(found.tools.pdftoppm).toEqual({ how: "env", command: path.join(envDir, "pdftoppm") });
  });

  it("2. then the PATH, by the bare name as before (also when the named folder is empty)", async () => {
    const { world } = worldWith(["pdfinfo", "pdftoppm", path.join(placeA, "pdfinfo")], {
      POPPLER_BIN_DIR: envDir,
    });
    pdf.resetPdfToolLookup(world);
    const found = await pdf.findPdfTools();
    expect(found.tools.pdfinfo).toEqual({ how: "path", command: "pdfinfo" });
    expect(found.tools.pdftoppm).toEqual({ how: "path", command: "pdftoppm" });
    expect(found.pathEntries).toBe(3);
  });

  it("3. then the usual places, in order, by full path", async () => {
    const { world } = worldWith([
      path.join(placeB, "pdfinfo"),
      path.join(placeA, "pdftoppm"),
      path.join(placeB, "pdftoppm"),
    ]);
    pdf.resetPdfToolLookup(world);
    const found = await pdf.findPdfTools();
    expect(found.tools.pdfinfo).toEqual({ how: "searched", command: path.join(placeB, "pdfinfo") });
    expect(found.tools.pdftoppm).toEqual({ how: "searched", command: path.join(placeA, "pdftoppm") });
  });

  it("3b. then any /nix/store/*poppler-utils*/bin, from ONE listing (no other folder is tried)", async () => {
    const { world, asked } = worldWith([
      path.join(nixPoppler, "pdfinfo"),
      path.join(nixPoppler, "pdftoppm"),
      path.join(nixDecoy, "pdfinfo"),
    ]);
    pdf.resetPdfToolLookup(world);
    const found = await pdf.findPdfTools();
    expect(found.tools.pdfinfo).toEqual({ how: "searched", command: path.join(nixPoppler, "pdfinfo") });
    expect(found.tools.pdftoppm).toEqual({ how: "searched", command: path.join(nixPoppler, "pdftoppm") });
    expect(found.nixStore).toEqual({ exists: true, popplerFolders: 1 }); // the folder, not the file named alike
    expect(asked.filter((c) => c.includes("poppler-data") || c.includes("replit-runtime-path"))).toEqual([]);
    // The order asked for one program: PATH, the usual places, then the store.
    expect(asked.filter((c) => c.endsWith("pdfinfo")).slice(0, 3)).toEqual([
      "pdfinfo",
      path.join(placeA, "pdfinfo"),
      path.join(placeB, "pdfinfo"),
    ]);
  });

  it("4. nothing anywhere: missing, and the readers refuse with the sentence (503)", async () => {
    const { world } = worldWith([]);
    pdf.resetPdfToolLookup(world);
    const found = await pdf.findPdfTools();
    expect(found.tools.pdfinfo).toEqual({ how: "missing", command: null });
    expect(found.tools.pdftoppm).toEqual({ how: "missing", command: null });

    for (const attempt of [pdf.requirePdfTools(), pdf.runPdfTool("pdfinfo", ["x.pdf"])]) {
      const err = await attempt.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(pdf.PdfToolsMissingError);
      const missing = err as InstanceType<typeof pdf.PdfToolsMissingError>;
      expect(missing.status).toBe(503);
      expect(missing.message).toBe(
        "This server is missing its PDF tools, so plans can't be read yet. Tell support.",
      );
      expect(failures.describeFailure(missing)).toMatchObject({
        status: 503,
        body: { code: "pdf_tools_missing", message: pdf.PDF_TOOLS_MISSING_MESSAGE },
      });
    }
  });

  it("one program found and the other not is still 'cannot read'", async () => {
    const { world } = worldWith(["pdfinfo"]);
    pdf.resetPdfToolLookup(world);
    expect((await pdf.findPdfTools()).tools).toEqual({
      pdfinfo: { how: "path", command: "pdfinfo" },
      pdftoppm: { how: "missing", command: null },
    });
    await expect(pdf.requirePdfTools()).rejects.toBeInstanceOf(pdf.PdfToolsMissingError);
  });

  it("the answer is remembered: the second ask looks nowhere", async () => {
    const { world, asked } = worldWith(["pdfinfo", "pdftoppm"]);
    pdf.resetPdfToolLookup(world);
    await pdf.findPdfTools();
    const first = asked.length;
    expect(first).toBeGreaterThan(0);
    await pdf.findPdfTools();
    await pdf.systemCheck();
    await pdf.requirePdfTools();
    expect(asked.length).toBe(first);
  });

  it("a nix store that cannot be read is skipped quietly", async () => {
    const { world } = worldWith([]);
    pdf.resetPdfToolLookup({ ...world, nixStore: NOWHERE });
    const found = await pdf.findPdfTools();
    expect(found.nixStore).toEqual({ exists: false, popplerFolders: 0 });
    expect(found.tools.pdfinfo.how).toBe("missing");
  });
});

describe("starting a PDF program", () => {
  it("'can it be started' is asked of the real thing: node yes, a made-up name no", async () => {
    expect(await pdf.canStartProgram(process.execPath)).toBe(true);
    expect(await pdf.canStartProgram(path.join(NOWHERE, "pdfinfo"))).toBe(false);
    expect(await pdf.canStartProgram("panelbid-test-no-such-program")).toBe(false);
  });

  it("a program that is gone when it is needed is the same case: the sentence, the raw text for the log only", async () => {
    // Found (says the made-up world), but there is nothing at that path.
    pdf.resetPdfToolLookup({
      env: { POPPLER_BIN_DIR: NOWHERE },
      usualPlaces: [],
      nixStore: NOWHERE,
      canStart: async () => true,
    });
    const err = await pdf.runPdfTool("pdfinfo", ["x.pdf"]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(pdf.PdfToolsMissingError);
    const missing = err as InstanceType<typeof pdf.PdfToolsMissingError>;
    expect(missing.reason).toBe("pdfinfo: ENOENT");
    expect(failures.failureSentence(missing)).toBe(pdf.PDF_TOOLS_MISSING_MESSAGE);
    expect(failures.failureSentence(missing)).not.toMatch(/ENOENT|spawn|pdfinfo/);
  });
});

describe("the start-up line", () => {
  it("ONE loud line when a program is missing, and the server still starts", async () => {
    pdf.resetPdfToolLookup(worldWith([]).world);
    const loud = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    await pdf.checkPdfToolsAtStartup(); // does not throw
    expect(loud).toHaveBeenCalledTimes(1);
    expect(loud.mock.calls[0]).toEqual([
      {
        pdfinfo: "missing",
        pdftoppm: "missing",
        pathEntries: 3,
        nixStore: { exists: true, hasPopplerFolder: true },
      },
      "PDF tools missing: the room reader and the price-sheet reader will refuse",
    ]);
  });

  it("no loud line when both are found", async () => {
    pdf.resetPdfToolLookup(worldWith(["pdfinfo", "pdftoppm"]).world);
    const loud = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    await pdf.checkPdfToolsAtStartup();
    expect(loud).not.toHaveBeenCalled();
  });
});

describe("GET /api/system/check", () => {
  it("is refused with no cookie", async () => {
    const reply = await running.call("GET", "/api/system/check");
    expect(reply.status).toBe(401);
    expect(reply.json).toMatchObject({ code: "sign_in_required" });
    expect(reply.text).not.toContain("pdfinfo");
  });

  it("signed in: says found or not and HOW, never where", async () => {
    const everywhere = [path.join(envDir, "pdfinfo"), path.join(nixPoppler, "pdftoppm")];
    pdf.resetPdfToolLookup(worldWith(everywhere, { POPPLER_BIN_DIR: envDir }).world);
    const cookie = await signIn(running);
    const reply = await running.call("GET", "/api/system/check", { cookie });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({
      pdfinfo: { found: true, how: "env" },
      pdftoppm: { found: true, how: "searched" },
      pathEntries: 3,
      nixStore: { exists: true, hasPopplerFolder: true },
    });
    // No path, no folder name, no environment value.
    expect(reply.text).not.toContain(root);
    expect(reply.text).not.toContain("from-env");
    expect(reply.text).not.toContain("abc123");
    expect(reply.text).not.toMatch(/[\\/]/);
  });

  it("signed in, nothing found: missing", async () => {
    pdf.resetPdfToolLookup({ ...worldWith([]).world, nixStore: NOWHERE });
    const cookie = await signIn(running);
    const reply = await running.call("GET", "/api/system/check", { cookie });
    expect(reply.json).toEqual({
      pdfinfo: { found: false, how: "missing" },
      pdftoppm: { found: false, how: "missing" },
      pathEntries: 3,
      nixStore: { exists: false, hasPopplerFolder: false },
    });
  });
});

describe("what the AI reader did, told apart without its own text", () => {
  class APIConnectionError extends Error {}
  class APIConnectionTimeoutError extends APIConnectionError {}
  const withStatus = (status: number) => Object.assign(new Error(`${status} provider text`), { status });

  it.each([
    ["no connection", new APIConnectionError("Connection error."), "ai_no_answer"],
    ["the provider's own fault (500)", withStatus(500), "ai_no_answer"],
    ["overloaded (529)", withStatus(529), "ai_no_answer"],
    ["a timeout", new APIConnectionTimeoutError("Request timed out."), "ai_too_slow"],
    ["a timeout by status (408)", withStatus(408), "ai_too_slow"],
    ["wrong key (401)", withStatus(401), "ai_refused"],
    ["not allowed (403)", withStatus(403), "ai_refused"],
    ["too many requests (429)", withStatus(429), "ai_refused"],
    ["request refused (400)", withStatus(400), "ai_refused"],
    ["something unknown", new Error("boom"), "ai_no_answer"],
  ])("%s", (_name, err, code) => {
    expect(failures.classifyAiError(err)).toBe(code);
  });

  it("an error nobody planned for becomes a 500 with a plain sentence, not its own text", () => {
    const answer = failures.describeFailure(new Error("ECONNREFUSED 10.0.0.5:5432 at /home/runner/x.ts:12"));
    expect(answer.status).toBe(500);
    expect(answer.body).toEqual({
      code: "server_fault",
      message: "Something went wrong on the server. Try again; if it keeps happening, tell support.",
    });
    expect(new failures.ReadingFailure("no_plan").message).toBe("Add a plan first.");
  });
});
