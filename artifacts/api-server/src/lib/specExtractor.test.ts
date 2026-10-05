/**
 * Regression tests for the non-destructive guarantees of spec extraction:
 *  (a) a page that fails processing keeps its previously extracted rows
 *  (b) a run where candidate detection fails on all files throws and
 *      mutates nothing
 *  (c) manual rows (sourceFileId null) always survive extraction
 *
 * Uses the real dev database (temp job, cleaned up) and the real pdftoppm
 * renderer; only the Anthropic client is mocked.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { writeFile, rm } from "node:fs/promises";
import { eq } from "drizzle-orm";

const mockCreate = vi.fn();
vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: { messages: { create: (...args: unknown[]) => mockCreate(...args) } },
}));

const { db, jobsTable, jobFilesTable, roomSpecsTable } = await import(
  "@workspace/db"
);
const { extractSpecsForJob, computeTileGrid } = await import("./specExtractor");

const GOOD_PDF = "/tmp/spec-test-good.pdf";
const CORRUPT_PDF = "/tmp/spec-test-corrupt.pdf";

let jobId: number;
let goodFileId: number;
let corruptFileId: number;

function aiResponse(rooms: unknown[]) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          rooms,
          material_key: [],
          fire_rating_present_anywhere: false,
        }),
      },
    ],
  };
}

const ROOM = {
  room_name: "TEST ROOM",
  room_number: "101",
  material_category: "frp",
  material_height: null,
  manufacturer: null,
  color: null,
  product_code: null,
  texture: null,
  fire_rating: null,
};

/** Build a minimal valid PDF with one text line per page. */
function buildPdf(pageTexts: string[]): Buffer {
  const objects: string[] = [];
  const n = pageTexts.length;
  // 1: catalog, 2: pages, 3: font, then per page: page obj + content obj
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  const kids = pageTexts.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`,
  );
  objects.push(
    `3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
  );
  pageTexts.forEach((text, i) => {
    const pageNum = 4 + i * 2;
    const contentNum = pageNum + 1;
    objects.push(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`,
    );
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(
      `${contentNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  });
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(body.length);
    body += obj;
  }
  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    body += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

beforeAll(async () => {
  // Two-page PDF whose text triggers candidate detection on both pages.
  await writeFile(
    GOOD_PDF,
    buildPdf([
      "ROOM FINISH SCHEDULE page one",
      "ROOM FINISH SCHEDULE page two",
    ]),
  );
  await writeFile(CORRUPT_PDF, "not a pdf");

  const [job] = await db
    .insert(jobsTable)
    .values({
      jobName: "__spec_extractor_test__",
      address: "x",
      city: "x",
      status: "needs_review",
    })
    .returning();
  jobId = job!.id;

  const files = await db
    .insert(jobFilesTable)
    .values([
      {
        jobId,
        fileName: "good.pdf",
        filePath: GOOD_PDF,
        fileSize: 1,
        fileType: "application/pdf",
        fileHash: `test-good-${Date.now()}`,
        needsOcr: false,
      },
      {
        jobId,
        fileName: "corrupt.pdf",
        filePath: CORRUPT_PDF,
        fileSize: 1,
        fileType: "application/pdf",
        fileHash: `test-corrupt-${Date.now()}`,
        needsOcr: false,
      },
    ])
    .returning();
  goodFileId = files[0]!.id;
  corruptFileId = files[1]!.id;
});

afterAll(async () => {
  await db.delete(jobsTable).where(eq(jobsTable.id, jobId));
  await rm(GOOD_PDF, { force: true });
  await rm(CORRUPT_PDF, { force: true });
  await rm("/tmp/spec-test.ps", { force: true });
});

async function specsForJob() {
  return db
    .select()
    .from(roomSpecsTable)
    .where(eq(roomSpecsTable.jobId, jobId));
}

async function getFiles() {
  return db.select().from(jobFilesTable).where(eq(jobFilesTable.jobId, jobId));
}

describe("computeTileGrid", () => {
  const MAX_TILE = 1568;
  const MAX_TILES = 24;

  function checkInvariants(widthPts: number, heightPts: number) {
    const grid = computeTileGrid(widthPts, heightPts);
    const pxW = Math.round((widthPts / 72) * grid.dpi);
    const pxH = Math.round((heightPts / 72) * grid.dpi);
    expect(grid.tiles.length).toBeLessThanOrEqual(MAX_TILES);
    for (const t of grid.tiles) {
      // Every crop, including overlap, stays under the no-downscale limit.
      expect(t.w).toBeLessThanOrEqual(MAX_TILE);
      expect(t.h).toBeLessThanOrEqual(MAX_TILE);
    }
    if (grid.tiles.length > 0) {
      // Full coverage: max extent reaches the page edges, no gaps between
      // consecutive tiles (each starts before the previous column/row ends).
      const maxX = Math.max(...grid.tiles.map((t) => t.x + t.w));
      const maxY = Math.max(...grid.tiles.map((t) => t.y + t.h));
      expect(maxX).toBeGreaterThanOrEqual(pxW);
      expect(maxY).toBeGreaterThanOrEqual(pxH);
      const xs = [...new Set(grid.tiles.map((t) => t.x))].sort((a, b) => a - b);
      const ys = [...new Set(grid.tiles.map((t) => t.y))].sort((a, b) => a - b);
      const w = grid.tiles[0]!.w;
      const h = grid.tiles[0]!.h;
      for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeLessThanOrEqual(xs[i - 1]! + w);
      for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeLessThanOrEqual(ys[i - 1]! + h);
    }
    return grid;
  }

  it("letter page fits in few tiles at full dpi", () => {
    const grid = checkInvariants(612, 792);
    expect(grid.dpi).toBe(150);
    expect(grid.tiles.length).toBeGreaterThan(0);
  });

  it("36x24 arch sheet keeps 150 dpi within tile cap", () => {
    const grid = checkInvariants(2592, 1728);
    expect(grid.dpi).toBe(150);
  });

  it("rotated 42x30 sheet (post-rotation dims) is covered", () => {
    checkInvariants(3024, 2160);
  });

  it("huge sheet reduces dpi instead of exceeding tile budget", () => {
    const grid = checkInvariants(8640, 8640); // 120in x 120in
    expect(grid.dpi).toBeLessThan(150);
  });

  it("tiny page yields no tiles (overview alone suffices)", () => {
    const grid = computeTileGrid(300, 300);
    expect(grid.tiles).toHaveLength(0);
  });
});

describe("extractSpecsForJob non-destructive guarantees", () => {
  it("throws and mutates nothing when all candidate detection fails", async () => {
    await db.insert(roomSpecsTable).values({
      jobId,
      sourceFileId: goodFileId,
      sourcePage: 1,
      roomName: "PRIOR ROW",
      materialCategory: "frp",
    });
    const files = (await getFiles()).filter((f) => f.id === corruptFileId);
    await expect(extractSpecsForJob(jobId, files)).rejects.toThrow(
      /candidate detection could not read/,
    );
    const specs = await specsForJob();
    expect(specs).toHaveLength(1);
    expect(specs[0]!.roomName).toBe("PRIOR ROW");
    await db.delete(roomSpecsTable).where(eq(roomSpecsTable.jobId, jobId));
  });

  it("keeps rows from pages that fail processing, replaces successful pages, preserves manual rows", async () => {
    // Prior extracted rows for both pages + one manual row.
    await db.insert(roomSpecsTable).values([
      { jobId, sourceFileId: goodFileId, sourcePage: 1, roomName: "OLD PAGE 1" },
      { jobId, sourceFileId: goodFileId, sourcePage: 2, roomName: "OLD PAGE 2" },
      { jobId, sourceFileId: null, sourcePage: null, roomName: "MANUAL ROW" },
    ]);

    // Page 1 succeeds, page 2 fails.
    mockCreate
      .mockResolvedValueOnce(aiResponse([ROOM]))
      .mockRejectedValueOnce(new Error("simulated AI failure"));

    const files = (await getFiles()).filter((f) => f.id === goodFileId);
    const result = await extractSpecsForJob(jobId, files);
    expect(result.candidatePages).toBe(2);
    expect(result.pagesProcessed).toBe(1);
    expect(result.pagesFailed).toBe(1);

    const specs = await specsForJob();
    const names = specs.map((s) => s.roomName).sort();
    // OLD PAGE 1 replaced by TEST ROOM; OLD PAGE 2 preserved; MANUAL ROW preserved.
    expect(names).toEqual(["MANUAL ROW", "OLD PAGE 2", "TEST ROOM"]);
    await db.delete(roomSpecsTable).where(eq(roomSpecsTable.jobId, jobId));
  });

  it("does not delete rows from other files sharing the same page numbers", async () => {
    // A second file whose pages overlap the good file's page numbers.
    const OTHER_PDF = "/tmp/spec-test-other.pdf";
    await writeFile(
      OTHER_PDF,
      buildPdf(["ROOM FINISH SCHEDULE other page one"]),
    );
    const [otherFile] = await db
      .insert(jobFilesTable)
      .values({
        jobId,
        fileName: "other.pdf",
        filePath: OTHER_PDF,
        fileSize: 1,
        fileType: "application/pdf",
        fileHash: `test-other-${Date.now()}`,
        needsOcr: false,
      })
      .returning();
    const otherFileId = otherFile!.id;

    try {
      // Prior rows: page 1 of BOTH files, including a merged row whose
      // sourcePages tuple references the other file's page 1.
      await db.insert(roomSpecsTable).values([
        { jobId, sourceFileId: goodFileId, sourcePage: 1, roomName: "GOOD P1" },
        { jobId, sourceFileId: goodFileId, sourcePage: 2, roomName: "GOOD P2" },
        {
          jobId,
          sourceFileId: otherFileId,
          sourcePage: 1,
          sourcePages: JSON.stringify([{ fileId: otherFileId, page: 1 }]),
          roomName: "OTHER P1",
        },
      ]);

      // Extraction runs over the GOOD file only; both its pages succeed.
      mockCreate
        .mockResolvedValueOnce(aiResponse([ROOM]))
        .mockResolvedValueOnce(aiResponse([]));
      const files = (await getFiles()).filter((f) => f.id === goodFileId);
      const result = await extractSpecsForJob(jobId, files);
      expect(result.pagesProcessed).toBe(2);

      const names = (await specsForJob()).map((s) => s.roomName).sort();
      // Good file's page rows replaced; other file's page 1 row untouched
      // even though it shares the page number.
      expect(names).toEqual(["OTHER P1", "TEST ROOM"]);
    } finally {
      await db.delete(roomSpecsTable).where(eq(roomSpecsTable.jobId, jobId));
      await db.delete(jobFilesTable).where(eq(jobFilesTable.id, otherFileId));
      await rm(OTHER_PDF, { force: true });
    }
  });

  it("throws without mutating when every candidate page fails processing", async () => {
    await db.insert(roomSpecsTable).values({
      jobId,
      sourceFileId: goodFileId,
      sourcePage: 1,
      roomName: "SURVIVOR",
    });
    mockCreate.mockRejectedValue(new Error("simulated AI outage"));

    const files = (await getFiles()).filter((f) => f.id === goodFileId);
    await expect(extractSpecsForJob(jobId, files)).rejects.toThrow(
      /0 of 2 candidate pages/,
    );
    const specs = await specsForJob();
    expect(specs).toHaveLength(1);
    expect(specs[0]!.roomName).toBe("SURVIVOR");
  });
});
