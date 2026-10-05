import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  jobFilesTable,
  jobsTable,
  planScansTable,
  roomSpecsTable,
  scheduleCandidatesTable,
  type JobFile,
  type InsertRoomSpec,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "./logger";

const execFileAsync = promisify(execFile);

// Advisory lock namespace for spec extraction (distinct from plan-scan ns).
// Shared by extraction and all room-spec row writes so concurrent edits can't
// be silently lost when extraction replaces rows.
export const SPEC_EXTRACT_LOCK_NS = 74202;

const SCHEDULE_TERMS = [
  "finish schedule",
  "room finish schedule",
  "interior finish schedule",
  "finish legend",
];

// Heuristic: a page that mentions rooms densely alongside keyword matches
// looks like a room finish table.
const ROOM_TOKEN_RE =
  /\b(room|rm\.?|toilet|restroom|kitchen|corridor|office|storage|janitor|vestibule|lobby|wash\s?bay|mech(?:anical)?|elec(?:trical)?)\b/gi;

export interface CandidatePage {
  file: JobFile;
  pageNumber: number;
  reason: string;
}

export interface CandidateDetection {
  candidates: CandidatePage[];
  /** Files whose text extraction failed during detection. */
  failedFileIds: number[];
}

async function extractPdfPages(buffer: Buffer): Promise<string[]> {
  const { extractText } = await import("unpdf");
  const { text } = await extractText(new Uint8Array(buffer), {
    mergePages: false,
  });
  return text.map((page) => page.replace(/\s+/g, " ").trim());
}

/**
 * Detect pages likely to be finish schedules across a job's files and
 * persist them as candidates. Files flagged needs_ocr are skipped (no text).
 */
export async function detectCandidatePages(
  jobId: number,
  files: JobFile[],
): Promise<CandidateDetection> {
  // Only material-category matches make a page a schedule candidate —
  // manufacturer brand names can appear anywhere (title blocks, price
  // sheets) and would inflate candidates with false positives.
  const scanRows = await db
    .select({
      fileId: planScansTable.fileId,
      pageNumber: planScansTable.pageNumber,
    })
    .from(planScansTable)
    .where(
      and(
        eq(planScansTable.jobId, jobId),
        ne(planScansTable.category, "manufacturer"),
      ),
    );
  const keywordPages = new Set(
    scanRows.map((r) => `${r.fileId}|${r.pageNumber}`),
  );

  const candidates: CandidatePage[] = [];
  const failedFileIds: number[] = [];
  for (const file of files) {
    if (file.needsOcr) continue;
    let pages: string[];
    try {
      pages = await extractPdfPages(await readFile(file.filePath));
    } catch (err) {
      logger.warn({ err, fileId: file.id }, "Extraction failed during candidate detection");
      failedFileIds.push(file.id);
      continue;
    }
    for (let p = 0; p < pages.length; p++) {
      const text = pages[p]!.toLowerCase();
      if (!text) continue;
      const pageNumber = p + 1;
      const scheduleTerm = SCHEDULE_TERMS.find((t) => text.includes(t));
      const roomTokens = pages[p]!.match(ROOM_TOKEN_RE)?.length ?? 0;
      const hasKeywordMatch = keywordPages.has(`${file.id}|${pageNumber}`);
      if (scheduleTerm) {
        candidates.push({ file, pageNumber, reason: `contains "${scheduleTerm}"` });
      } else if (hasKeywordMatch && roomTokens >= 8) {
        candidates.push({
          file,
          pageNumber,
          reason: `dense room table (${roomTokens} room tokens) with keyword matches`,
        });
      }
    }
  }

  // Persist candidates (replace per job).
  await db.transaction(async (tx) => {
    await tx
      .delete(scheduleCandidatesTable)
      .where(eq(scheduleCandidatesTable.jobId, jobId));
    if (candidates.length > 0) {
      await tx.insert(scheduleCandidatesTable).values(
        candidates.map((c) => ({
          jobId,
          fileId: c.file.id,
          pageNumber: c.pageNumber,
          reason: c.reason,
        })),
      );
    }
  });

  return { candidates, failedFileIds };
}

/** Run pdftoppm for one page and return the produced JPEG buffer. */
async function runPdftoppm(
  pdfPath: string,
  pageNumber: number,
  extraArgs: string[],
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "specpage-"));
  try {
    const prefix = join(dir, "page");
    await execFileAsync("pdftoppm", [
      "-jpeg",
      "-f",
      String(pageNumber),
      "-l",
      String(pageNumber),
      "-jpegopt",
      "quality=80",
      ...extraArgs,
      pdfPath,
      prefix,
    ]);
    // pdftoppm names output page-<n>.jpg with zero padding depending on total pages.
    const { readdir } = await import("node:fs/promises");
    const produced = (await readdir(dir)).find((f) => f.endsWith(".jpg"));
    if (!produced) throw new Error("pdftoppm produced no output");
    return await readFile(join(dir, produced));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Rendered page size in points from pdfinfo (falls back to 36x24in sheet).
 * pdfinfo reports the pre-rotation media box, but pdftoppm renders
 * post-rotation — swap dimensions when the page rotation is 90/270.
 */
async function getPageSizePoints(
  pdfPath: string,
  pageNumber: number,
): Promise<{ width: number; height: number }> {
  try {
    const { stdout } = await execFileAsync("pdfinfo", [
      "-f",
      String(pageNumber),
      "-l",
      String(pageNumber),
      pdfPath,
    ]);
    const m = stdout.match(/Page\s+\d+\s+size:\s+([\d.]+)\s+x\s+([\d.]+)/);
    if (m) {
      let width = parseFloat(m[1]!);
      let height = parseFloat(m[2]!);
      const rot = stdout.match(/Page\s+\d+\s+rot:\s+(\d+)/);
      if (rot && (rot[1] === "90" || rot[1] === "270")) {
        [width, height] = [height, width];
      }
      return { width, height };
    }
  } catch {
    // fall through to default
  }
  return { width: 2592, height: 1728 };
}

/**
 * Render one PDF page as a full-page overview plus four overlapping
 * high-resolution quadrant crops. Anthropic downscales large images to
 * ~1568px on the longest edge, which makes small dimension text (heights,
 * F.F. callouts) unreadable on a full plan sheet — the quadrants preserve
 * that detail.
 */
export interface TileGrid {
  dpi: number;
  tiles: { x: number; y: number; w: number; h: number }[];
}

/**
 * Compute an overlapping tile grid for a page of the given size (points).
 *
 * Invariants (asserted by tests):
 * - every tile, INCLUDING overlap, stays <= maxTilePx on both edges so the
 *   API never downscales it (that is what keeps dimension text readable);
 * - the grid fully covers the page with no gaps;
 * - at most maxTiles tiles — for very large sheets the DPI is reduced
 *   until the grid fits, trading resolution for a bounded request size.
 */
export function computeTileGrid(
  widthPts: number,
  heightPts: number,
  {
    baseDpi = 150,
    maxTilePx = 1568,
    overlapFrac = 0.1,
    maxTiles = 24,
  } = {},
): TileGrid {
  // Effective tile edge = base + 2*overlap, so size the base tile such that
  // the crop including overlap stays within maxTilePx.
  const baseTile = Math.floor(maxTilePx / (1 + 2 * overlapFrac));

  let dpi = baseDpi;
  for (;;) {
    const pxW = Math.round((widthPts / 72) * dpi);
    const pxH = Math.round((heightPts / 72) * dpi);
    const cols = Math.max(1, Math.ceil(pxW / baseTile));
    const rows = Math.max(1, Math.ceil(pxH / baseTile));
    if (cols * rows > maxTiles && dpi > 30) {
      dpi = Math.max(30, dpi - 15);
      continue;
    }
    if (cols * rows <= 1) return { dpi, tiles: [] };

    const tileW = Math.ceil(pxW / cols);
    const tileH = Math.ceil(pxH / rows);
    const overlapX = Math.round(tileW * overlapFrac);
    const overlapY = Math.round(tileH * overlapFrac);
    const tiles: TileGrid["tiles"] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        tiles.push({
          x: Math.max(0, c * tileW - overlapX),
          y: Math.max(0, r * tileH - overlapY),
          w: tileW + 2 * overlapX,
          h: tileH + 2 * overlapY,
        });
      }
    }
    return { dpi, tiles };
  }
}

export async function renderPageImages(
  pdfPath: string,
  pageNumber: number,
): Promise<Buffer[]> {
  const { width, height } = await getPageSizePoints(pdfPath, pageNumber);

  // Multi-image requests reject any image over ~2576px on a side, so scale
  // the full-page overview to stay under 2400px on its longest edge.
  const longEdgeInches = Math.max(width, height) / 72;
  const overviewDpi = Math.max(30, Math.min(150, Math.floor(2400 / longEdgeInches)));
  const full = await runPdftoppm(pdfPath, pageNumber, ["-r", String(overviewDpi)]);

  const grid = computeTileGrid(width, height);
  const tiles: Buffer[] = [];
  for (const t of grid.tiles) {
    tiles.push(
      await runPdftoppm(pdfPath, pageNumber, [
        "-r",
        String(grid.dpi),
        "-x",
        String(t.x),
        "-y",
        String(t.y),
        "-W",
        String(t.w),
        "-H",
        String(t.h),
      ]),
    );
  }
  return [full, ...tiles];
}

const ExtractedRoom = z.object({
  room_name: z.string().nullable(),
  room_number: z.string().nullable(),
  material_category: z.enum(["frp", "stainless", "pvc"]).nullable(),
  material_height: z.string().nullable(),
  ceiling_height: z.string().nullish().default(null),
  wall_finish_code: z.string().nullish().default(null),
  source: z.enum(["schedule", "elevation"]).nullish().default(null),
  manufacturer: z.string().nullable(),
  color: z.string().nullable(),
  product_code: z.string().nullable(),
  texture: z.string().nullable(),
  fire_rating: z.string().nullable(),
});

const FinishCode = z.object({
  code: z.string().nullable(),
  material_name: z.string().nullish().default(null),
  material_category: z.enum(["frp", "stainless", "pvc"]).nullish().default(null),
  manufacturer: z.string().nullable().optional().default(null),
  product_line: z.string().nullable().optional().default(null),
  texture: z.string().nullish().default(null),
  color: z.string().nullable(),
});

const ExtractionPayload = z.object({
  page_type: z
    .enum(["finish_schedule", "finish_codes_legend", "elevation", "other"])
    .nullish()
    .default("other"),
  rooms: z.array(ExtractedRoom),
  material_key: z.array(FinishCode).default([]),
  fire_rating_present_anywhere: z.boolean(),
});

const EXTRACTION_PROMPT = `You are reading one page of construction plans. It may contain a room FINISH SCHEDULE table, a FINISH SCHEDULE CODES legend, interior ELEVATION drawings, or a combination.

First classify the page structurally (never by page/sheet number):
- "finish_schedule": a table with one row per room (RM # / room number column, room name, and finish columns such as Floor Fin., Base Fin., Wall Fin., Clg Fin., Ceiling Height, Comments).
- "finish_codes_legend": a legend/key mapping finish codes (e.g. FRP-1, MLP-1, PT-1) to material descriptions (material name, texture, color, manufacturer).
- "elevation": interior elevation drawings with material tags and dimension strings.
- "other": none of the above.
If both a schedule table and a codes legend appear on the page, use "finish_schedule" and extract BOTH the rooms and the legend.

THE FINISH SCHEDULE TABLE IS THE AUTHORITATIVE SOURCE. When the page has a finish schedule table:
- Extract one room entry per table row whose Wall Fin. value is a wall PANEL code — FRP (fiberglass reinforced panel), MLP (metal liner panel), SS (stainless steel panel), PVC panel, or similar panel codes. NEVER create an entry for a room whose wall finish is a non-panel finish such as GYP. BD. / gypsum, paint (PT), tile (CT/VCT), plaster, or exposed structure — omit those rows entirely.
- For each such room capture: room_number (RM # column), room_name, wall_finish_code (the raw Wall Fin. code exactly as written, e.g. "FRP-1"), ceiling_height (the Ceiling Height / Clg Ht column value, e.g. "9'-0\\""), and set source to "schedule".
- Read every row of the table carefully, including in the tiles — do not skip rows.

For elevation drawings, extract rooms that show wall panel material tags (FRP, stainless, PVC, MLP) and set source to "elevation". Always capture the room number when it appears in the elevation title or room callout (e.g. "RESTROOM 108" → room_number "108"). NEVER create a room entry from a drawing/sheet title alone (e.g. "Corridor Elevation", "Interior Elevations") — only from actual rooms that show a wall panel material tag.

Also extract the finish codes legend into material_key whenever a legend appears anywhere on the page: for each code give the raw code, the material name (e.g. "Fiberglass Reinforced Panel"), material_category ("frp" for FRP, "stainless" for stainless/metal panels, "pvc" for PVC; null if unclear), texture (e.g. "Smooth"), color (e.g. "White"), manufacturer and product_line if listed.

When scanning finish schedules and legends, actively look for these common manufacturer / product-line names and capture them in the manufacturer (or product_line) field when they appear: Marlite, Crane, Panolam, Koroguard, Inpro, Acrovyn, Kemlite, Glasliner, Extrutech, Delpro, Altro. They may appear in comments columns, legend descriptions, or spec callouts. Only record one when it is actually printed on the page.

Rules:
- If a field cannot be determined from this page, use null. NEVER guess or infer values not shown.
- material_height: actively look for height values associated with each material tag.
  - In schedules, heights often use F.F. (finish floor) notation, e.g. 'FRP F.F. 0" ... 3'-8"' means the material runs from finish floor up to 3'-8" — store "3'-8\\"" as the height.
  - On interior elevation drawings, the height is the vertical dimension string attached (by a dimension line or leader) to the material tag — e.g. a "3'-4"" dimension alongside an FRP tag means the FRP is 3'-4" tall. Dimensions typically run from F.F. 0" (finish floor baseline) to the top of the panel. Trace each material tag to its nearest associated vertical dimension.
  - Also check for wainscot heights (e.g. 4'-0" wainscot).
  - When the notation indicates the material runs to the ceiling, to deck, or is "open to structure" (full height), store exactly "to ceiling" as material_height. Schedule rows where the wall panel covers the full wall also count as "to ceiling".
  - If the same room shows the material at different heights on different walls, use the tallest.
  - Only use null for material_height when the page truly shows no height information for that material tag.
- ceiling_height is the room's ceiling height from the schedule column — keep it separate from material_height.
- material_category must be one of "frp", "stainless", "pvc", or null if the material type is unclear (a legend on the same page may make it clear).
- Set fire_rating_present_anywhere to true only if any fire/flame class rating appears anywhere on the page.

Respond with ONLY strict JSON (no markdown fences, no commentary) in this exact shape:
{
  "page_type": "finish_schedule"|"finish_codes_legend"|"elevation"|"other",
  "rooms": [
    {"room_name": string|null, "room_number": string|null, "material_category": "frp"|"stainless"|"pvc"|null, "material_height": string|null, "ceiling_height": string|null, "wall_finish_code": string|null, "source": "schedule"|"elevation"|null, "manufacturer": string|null, "color": string|null, "product_code": string|null, "texture": string|null, "fire_rating": string|null}
  ],
  "material_key": [
    {"code": string|null, "material_name": string|null, "material_category": "frp"|"stainless"|"pvc"|null, "manufacturer": string|null, "product_line": string|null, "texture": string|null, "color": string|null}
  ],
  "fire_rating_present_anywhere": boolean
}`;

async function extractFromPage(
  images: Buffer[],
): Promise<z.infer<typeof ExtractionPayload>> {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "The first image is the full plan page for overall context. The following images are overlapping full-resolution tiles of the SAME page, in reading order (left to right, top to bottom) — use them to read small text such as vertical dimension strings and F.F. height callouts attached to material tags.",
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
          { type: "text", text: EXTRACTION_PROMPT },
        ],
      },
    ],
  });
  const block = message.content[0];
  const text = block && block.type === "text" ? block.text : "";
  // Strip accidental code fences / prose preamble before parsing: keep the
  // outermost JSON object only.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("Model response contained no JSON object");
  }
  return ExtractionPayload.parse(JSON.parse(cleaned.slice(start, end + 1)));
}

/**
 * Parse the room_specs.source_pages column: JSON array of {fileId, page}
 * tuples. Legacy plain-text values ("15, 19") yield an empty list — callers
 * fall back to (sourceFileId, sourcePage).
 */
export function parseSourcePages(
  raw: string | null | undefined,
): { fileId: number; page: number }[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is { fileId: number; page: number } =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as { fileId?: unknown }).fileId === "number" &&
        typeof (p as { page?: unknown }).page === "number",
    );
  } catch {
    return [];
  }
}

/** Normalize a finish code for lookup: uppercase, strip spaces ("frp - 1" → "FRP-1"). */
export function normalizeCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const norm = code.toUpperCase().replace(/\s+/g, "");
  return norm.length > 0 ? norm : null;
}

type FinishCodeEntry = z.infer<typeof FinishCode>;

/** Merge two legend entries for the same code — earlier values win, later fill gaps. */
export function mergeFinishCode(
  base: FinishCodeEntry,
  extra: FinishCodeEntry,
): FinishCodeEntry {
  return {
    code: base.code ?? extra.code,
    material_name: base.material_name ?? extra.material_name,
    material_category: base.material_category ?? extra.material_category,
    manufacturer: base.manufacturer ?? extra.manufacturer,
    product_line: base.product_line ?? extra.product_line,
    texture: base.texture ?? extra.texture,
    color: base.color ?? extra.color,
  };
}

/** Infer a material category from the raw finish code when the legend/model didn't. */
function categoryFromCode(
  code: string | null,
): "frp" | "stainless" | "pvc" | null {
  if (!code) return null;
  if (code.startsWith("FRP")) return "frp";
  if (code.startsWith("SS") || code.startsWith("MLP")) return "stainless";
  if (code.startsWith("PVC")) return "pvc";
  return null;
}

type MergedRoom = z.infer<typeof ExtractedRoom> & {
  fileId: number;
  pageNumber: number;
  /** All pages that contributed data to this (possibly merged) row. */
  contributingPages?: { fileId: number; pageNumber: number }[];
};

/** Room number for keying: explicit column first, else digits in the room name. */
function roomNumberOf(r: MergedRoom): string | null {
  const explicit = normalizeCode(r.room_number)?.replace(/^0+(?=\d)/, "");
  if (explicit) return explicit;
  const m = r.room_name?.match(/\b(\d{2,4}[A-Z]?)\b/i);
  return m ? m[1]!.toUpperCase().replace(/^0+(?=\d)/, "") : null;
}

/** Normalized alpha-only room name for fuzzy matching. */
function nameKeyOf(r: MergedRoom): string | null {
  const name = r.room_name
    ?.toUpperCase()
    .replace(/\bELEVATIONS?\b/g, "")
    .replace(/[^A-Z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return name && name.length >= 3 ? name : null;
}

/** True when one normalized name clearly contains the other (e.g. "WAREHOUSE BREAKROOM" ⊇ "BREAKROOM"). */
function namesMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 4) return false;
  const longTokens = new Set(long.split(" "));
  return short.split(" ").every((t) => longTokens.has(t));
}

/** Non-panel wall finish codes that must never produce a room row. */
const NON_PANEL_CODE_RE =
  /^(GYP|GWB|GB|PT|PNT|PAINT|CT|VCT|LVT|TILE|PLAS|PLASTER|CMU|BRK|WD|EXP)\b/;

/** Does this room show any evidence of a wall PANEL product? */
function hasPanelEvidence(
  room: MergedRoom,
  legend: Map<string, FinishCodeEntry>,
): boolean {
  const code = normalizeCode(room.wall_finish_code);
  if (code && NON_PANEL_CODE_RE.test(code)) return false;
  if (room.material_category) return true;
  if (code) {
    if (categoryFromCode(code)) return true;
    const entry = legend.get(code);
    if (entry?.material_category) return true;
  }
  return false;
}

/** Fill null fields of `base` from `extra` — base always wins on conflict. */
function fillGaps(base: MergedRoom, extra: MergedRoom): void {
  for (const key of [
    "room_name",
    "room_number",
    "material_category",
    "material_height",
    "ceiling_height",
    "wall_finish_code",
    "manufacturer",
    "color",
    "product_code",
    "texture",
    "fire_rating",
  ] as const) {
    if (base[key] == null && extra[key] != null) {
      (base as Record<string, unknown>)[key] = extra[key];
    }
  }
}

/**
 * Cross-source merge: finish-schedule rows are primary; elevation rows only
 * add rooms or fill gaps, keyed by room number (falling back to room name).
 * Then resolve finish codes via the legend and "to ceiling" heights via the
 * schedule ceiling height.
 */
export function buildMergedRows(
  jobId: number,
  extracted: MergedRoom[],
  legend: Map<string, FinishCodeEntry>,
): InsertRoomSpec[] {
  // Drop rows without panel evidence up front: non-panel wall finishes
  // (GYP. BD., paint, tile...) and sheet-title artifacts must not create rows.
  const panelRooms = extracted.filter(
    (r) =>
      hasPanelEvidence(r, legend) &&
      !/\bELEVATIONS?\b\s*$/i.test(r.room_name?.trim() ?? ""),
  );

  // Schedule rows first (primary), then elevation rows fill gaps/add rooms.
  const ordered = [
    ...panelRooms.filter((r) => r.source === "schedule"),
    ...panelRooms.filter((r) => r.source !== "schedule"),
  ];

  const merged: MergedRoom[] = [];
  const byNumber = new Map<string, MergedRoom>();

  const absorb = (target: MergedRoom, extra: MergedRoom) => {
    fillGaps(target, extra);
    target.contributingPages!.push({
      fileId: extra.fileId,
      pageNumber: extra.pageNumber,
    });
  };

  for (const room of ordered) {
    const num = roomNumberOf(room);
    const nameKey = nameKeyOf(room);

    let target: MergedRoom | undefined;
    if (num) {
      target = byNumber.get(num);
    } else if (nameKey) {
      // Unnumbered row: merge into a numbered/named row with a matching name.
      target = merged.find((m) => {
        const mName = nameKeyOf(m);
        return mName != null && namesMatch(mName, nameKey);
      });
    }

    if (target) {
      absorb(target, room);
    } else {
      const copy: MergedRoom = {
        ...room,
        contributingPages: [{ fileId: room.fileId, pageNumber: room.pageNumber }],
      };
      merged.push(copy);
      if (num) byNumber.set(num, copy);
    }
  }

  // Second pass: unnumbered rows may have been added before we could know a
  // better match existed — merge any remaining name-matched pairs.
  for (let i = merged.length - 1; i >= 0; i--) {
    const room = merged[i]!;
    if (roomNumberOf(room)) continue;
    const nameKey = nameKeyOf(room);
    if (!nameKey) continue;
    const target = merged.find((m, j) => {
      if (j === i) return false;
      const mName = nameKeyOf(m);
      return mName != null && namesMatch(mName, nameKey);
    });
    if (target) {
      absorb(target, room);
      merged.splice(i, 1);
    }
  }

  const rows: InsertRoomSpec[] = [];
  for (const room of merged) {
    // Resolve the wall finish code through the legend (any page in the set).
    const code = normalizeCode(room.wall_finish_code);
    const entry = code ? legend.get(code) : undefined;
    if (entry) {
      room.material_category ??= entry.material_category;
      room.manufacturer ??= entry.manufacturer;
      room.texture ??= entry.texture;
      room.color ??= entry.color;
      room.product_code ??=
        entry.product_line ?? entry.material_name ?? room.wall_finish_code;
    } else if (room.wall_finish_code) {
      // No legend match: keep the raw code visible.
      room.product_code ??= room.wall_finish_code;
    }
    room.material_category ??= categoryFromCode(code);

    // Resolve to-ceiling heights against the schedule ceiling height —
    // uniformly, for every merged room that has both pieces of information.
    if (
      room.material_height &&
      /to (the )?(ceiling|deck|structure)|full h(eigh)?t|open to structure/i.test(
        room.material_height,
      ) &&
      room.ceiling_height
    ) {
      room.material_height = room.ceiling_height;
    }

    const pages = room.contributingPages ?? [
      { fileId: room.fileId, pageNumber: room.pageNumber },
    ];
    // Stored as JSON (fileId, page) tuples so stale-row replacement can match
    // full page identity — page numbers alone collide across files.
    const uniquePages = [
      ...new Map(
        pages.map((p) => [`${p.fileId}|${p.pageNumber}`, p] as const),
      ).values(),
    ].sort((a, b) => a.fileId - b.fileId || a.pageNumber - b.pageNumber);

    const ambiguous = !room.material_category || !room.room_name;
    rows.push({
      jobId,
      sourceFileId: room.fileId,
      sourcePage: room.pageNumber,
      sourcePages: JSON.stringify(
        uniquePages.map((p) => ({ fileId: p.fileId, page: p.pageNumber })),
      ),
      roomName: room.room_name,
      roomNumber: room.room_number,
      materialCategory: room.material_category,
      materialHeight: room.material_height,
      ceilingHeight: room.ceiling_height,
      manufacturer: room.manufacturer,
      color: room.color,
      productCode: room.product_code,
      texture: room.texture,
      fireRating: room.fire_rating,
      fireRatingDefaulted: false,
      extractionConfidence: ambiguous ? "ambiguous" : "high",
    });
  }
  return rows;
}

export interface SpecExtractionResult {
  candidatePages: number;
  pagesProcessed: number;
  pagesFailed: number;
  filesFailed: number;
  roomsExtracted: number;
  ambiguousRooms: number;
}

/**
 * Full pipeline: detect candidate pages, render each to an image, extract
 * room specs with Claude vision, and replace the job's room_specs rows.
 */
export async function extractSpecsForJob(
  jobId: number,
  files: JobFile[],
): Promise<SpecExtractionResult> {
  const { candidates, failedFileIds } = await detectCandidatePages(jobId, files);

  // If detection itself failed on some files and produced nothing trustworthy,
  // abort before touching existing data — this is a failed run, not "no specs".
  if (candidates.length === 0 && failedFileIds.length > 0) {
    throw new Error(
      `Spec extraction failed: candidate detection could not read ${failedFileIds.length} file(s) and found no finish-schedule pages`,
    );
  }

  // Genuinely no candidate pages found: leave existing rows untouched.
  if (candidates.length === 0) {
    return {
      candidatePages: 0,
      pagesProcessed: 0,
      pagesFailed: 0,
      filesFailed: 0,
      roomsExtracted: 0,
      ambiguousRooms: 0,
    };
  }

  let pagesProcessed = 0;
  let anyFireRatingSeen = false;
  // Pages successfully processed — only these pages' prior rows get replaced.
  const processedPages: { fileId: number; pageNumber: number }[] = [];
  let pagesFailed = 0;

  // All extracted rooms across pages, tagged with their source page so the
  // cross-source merge can attribute the surviving row correctly.
  type ExtractedRoomWithPage = z.infer<typeof ExtractedRoom> & {
    fileId: number;
    pageNumber: number;
  };
  const extracted: ExtractedRoomWithPage[] = [];
  // Legend entries collected from ANY page in the set (legend may share a
  // page with the schedule or sit on a nearby sheet).
  const legend = new Map<string, z.infer<typeof FinishCode>>();

  for (const candidate of candidates) {
    try {
      const images = await renderPageImages(
        candidate.file.filePath,
        candidate.pageNumber,
      );
      const payload = await extractFromPage(images);
      pagesProcessed++;
      processedPages.push({
        fileId: candidate.file.id,
        pageNumber: candidate.pageNumber,
      });
      if (payload.fire_rating_present_anywhere) anyFireRatingSeen = true;

      logger.info(
        {
          jobId,
          page: candidate.pageNumber,
          pageType: payload.page_type,
          rooms: payload.rooms.length,
          legendEntries: payload.material_key.length,
        },
        "Page classified and extracted",
      );

      for (const entry of payload.material_key) {
        const key = normalizeCode(entry.code);
        if (!key) continue;
        const prev = legend.get(key);
        // First complete entry wins; later pages only fill gaps.
        legend.set(key, prev ? mergeFinishCode(prev, entry) : entry);
      }

      for (const room of payload.rooms) {
        // Trust the page-level classification when the room-level source is
        // missing: schedule pages yield schedule rows.
        if (!room.source) {
          room.source =
            payload.page_type === "finish_schedule" ? "schedule" : "elevation";
        }
        extracted.push({
          ...room,
          fileId: candidate.file.id,
          pageNumber: candidate.pageNumber,
        });
      }
    } catch (err) {
      pagesFailed++;
      logger.error(
        { err, jobId, fileId: candidate.file.id, page: candidate.pageNumber },
        "Spec extraction failed for page",
      );
    }
  }

  if (legend.size > 0) {
    logger.info(
      { jobId, legend: [...legend.values()] },
      "Extracted finish codes legend",
    );
  }

  const rows = buildMergedRows(jobId, extracted, legend);

  // Default fire rating to "Class C" only when no rating appeared anywhere.
  if (!anyFireRatingSeen) {
    for (const row of rows) {
      if (row.fireRating == null) {
        row.fireRating = "Class C";
        row.fireRatingDefaulted = true;
      }
    }
  }

  // If we found candidate pages but every single one failed to process,
  // fail loudly instead of silently wiping previously extracted data.
  if (candidates.length > 0 && pagesProcessed === 0) {
    throw new Error(
      `Spec extraction failed: 0 of ${candidates.length} candidate pages could be processed`,
    );
  }

  // Atomically replace extracted specs, serialized per job — but ONLY for
  // pages that were successfully processed this run. Prior rows from pages
  // that failed (render/AI error) and manual rows (sourceFileId null) are
  // never touched, so a partial failure can't lose data.
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${SPEC_EXTRACT_LOCK_NS}, ${jobId})`,
    );
    // A merged row can carry data from several pages (sourcePages), so a row
    // must be replaced when ANY of its contributing (file, page) pairs was
    // reprocessed — matching only the primary sourcePage would leave stale
    // duplicates, and matching page numbers alone would wrongly delete rows
    // from other files that happen to share the same page number.
    const processedKeys = new Set(
      processedPages.map((p) => `${p.fileId}|${p.pageNumber}`),
    );
    const existing = await tx
      .select({
        id: roomSpecsTable.id,
        sourceFileId: roomSpecsTable.sourceFileId,
        sourcePage: roomSpecsTable.sourcePage,
        sourcePages: roomSpecsTable.sourcePages,
      })
      .from(roomSpecsTable)
      .where(eq(roomSpecsTable.jobId, jobId));
    const staleIds = existing
      .filter((r) => {
        if (r.sourceFileId == null) return false; // manual rows untouched
        const keys = new Set<string>();
        if (r.sourcePage != null) keys.add(`${r.sourceFileId}|${r.sourcePage}`);
        for (const p of parseSourcePages(r.sourcePages)) {
          keys.add(`${p.fileId}|${p.page}`);
        }
        return [...keys].some((k) => processedKeys.has(k));
      })
      .map((r) => r.id);
    if (staleIds.length > 0) {
      await tx
        .delete(roomSpecsTable)
        .where(sql`${roomSpecsTable.id} IN ${staleIds}`);
    }
    if (rows.length > 0) {
      await tx.insert(roomSpecsTable).values(rows);
    }
  });

  return {
    candidatePages: candidates.length,
    pagesProcessed,
    pagesFailed,
    filesFailed: failedFileIds.length,
    roomsExtracted: rows.length,
    ambiguousRooms: rows.filter((r) => r.extractionConfidence === "ambiguous")
      .length,
  };
}
