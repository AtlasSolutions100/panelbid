/**
 * The two PDF programs the readers need (poppler): `pdfinfo` counts and
 * measures pages, `pdftoppm` turns a page into a picture.
 *
 * This is the ONLY place that finds and starts them. Both readers (the room
 * reader and the price-sheet reader) go through runPdfTool().
 *
 * They are separate programs on the server, and on the live host they have
 * been there in the editor's shell and not for the published server. So the
 * code looks for them itself, in this order, and remembers the answer for
 * the life of the process:
 *   1. "env":      the folder named by POPPLER_BIN_DIR, when set;
 *   2. "path":     the PATH, as before (the bare name);
 *   3. "searched": the usual places: /usr/bin, /usr/local/bin,
 *                  /run/current-system/sw/bin, ~/.nix-profile/bin and the
 *                  bin folder of any folder in /nix/store whose name has
 *                  "poppler-utils" in it (ONE listing of /nix/store, never
 *                  a walk; skipped quietly if unreadable);
 *   4. "missing".
 * A program found in 1 or 3 is started by its full path.
 *
 * When a program cannot be started the readers cannot work at all. That is
 * its own case with its own sentence (503): it is never reported as "a page
 * could not be turned into a picture", and the raw text ("spawn pdfinfo
 * ENOENT") goes to the log only.
 */
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "./logger";

const execFileAsync = promisify(execFile);

export const PDF_TOOLS = ["pdfinfo", "pdftoppm"] as const;
export type PdfTool = (typeof PDF_TOOLS)[number];
export type FoundHow = "env" | "path" | "searched" | "missing";

export const PDF_TOOLS_MISSING_MESSAGE =
  "This server is missing its PDF tools, so plans can't be read yet. Tell support.";

export class PdfToolsMissingError extends Error {
  readonly code = "pdf_tools_missing";
  readonly status = 503;
  constructor(
    readonly tool: PdfTool,
    /** For the server log only, e.g. "pdfinfo: ENOENT". */
    readonly reason: string,
  ) {
    super(PDF_TOOLS_MISSING_MESSAGE);
    this.name = "PdfToolsMissingError";
  }
}

/** The program is not there (ENOENT) or may not be run (EACCES). */
function couldNotStart(err: unknown): string | null {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "EACCES" ? code : null;
}

/**
 * Can this command be started? It is asked for its version. Any outcome but
 * "not there" / "may not be run" (even an odd exit code) means it started.
 */
export async function canStartProgram(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ["-v"], { timeout: 10_000 });
    return true;
  } catch (err) {
    return couldNotStart(err) === null;
  }
}

// ---------------------------------------------------------------------------
// Finding the programs
// ---------------------------------------------------------------------------

/** What the lookup may look at. The tests hand in their own. */
export interface LookupWorld {
  /** Only POPPLER_BIN_DIR and PATH are read. */
  env: Record<string, string | undefined>;
  /** Folders tried after the PATH, in order. */
  usualPlaces: string[];
  /** Listed once for folders named *poppler-utils*. */
  nixStore: string;
  canStart(command: string): Promise<boolean>;
}

function defaultWorld(): LookupWorld {
  return {
    env: process.env,
    usualPlaces: [
      "/usr/bin",
      "/usr/local/bin",
      "/run/current-system/sw/bin",
      path.join(homedir(), ".nix-profile", "bin"),
    ],
    nixStore: "/nix/store",
    canStart: canStartProgram,
  };
}

export interface PdfToolLocation {
  how: FoundHow;
  /** What to start: a full path, or the bare name for the PATH. Null: missing. */
  command: string | null;
}

export interface PdfToolsLookup {
  tools: Record<PdfTool, PdfToolLocation>;
  /** How many folders the server's PATH names. */
  pathEntries: number;
  nixStore: { exists: boolean; popplerFolders: number };
}

async function lookUp(world: LookupWorld): Promise<PdfToolsLookup> {
  // One listing of the nix store (never deeper). Unreadable: as if not there.
  let nixExists = false;
  let nixBins: string[] = [];
  try {
    // Folders only: the store also holds files named alike (*.drv).
    const entries = await readdir(world.nixStore, { withFileTypes: true });
    nixExists = true;
    nixBins = entries
      .filter((entry) => entry.isDirectory() && entry.name.includes("poppler-utils"))
      .map((entry) => entry.name)
      .sort()
      .map((name) => path.join(world.nixStore, name, "bin"));
  } catch {
    // skipped quietly
  }

  const envDir = world.env.POPPLER_BIN_DIR?.trim();
  const searched = [...world.usualPlaces, ...nixBins];

  const find = async (tool: PdfTool): Promise<PdfToolLocation> => {
    if (envDir) {
      const command = path.join(envDir, tool);
      if (await world.canStart(command)) return { how: "env", command };
    }
    if (await world.canStart(tool)) return { how: "path", command: tool };
    for (const dir of searched) {
      const command = path.join(dir, tool);
      if (await world.canStart(command)) return { how: "searched", command };
    }
    return { how: "missing", command: null };
  };

  return {
    tools: { pdfinfo: await find("pdfinfo"), pdftoppm: await find("pdftoppm") },
    pathEntries: (world.env.PATH ?? world.env.Path ?? "")
      .split(path.delimiter)
      .filter((entry) => entry.trim() !== "").length,
    nixStore: { exists: nixExists, popplerFolders: nixBins.length },
  };
}

let world: LookupWorld = defaultWorld();
let remembered: Promise<PdfToolsLookup> | null = null;

/** Where the two programs are. Looked up once, then remembered. */
export function findPdfTools(): Promise<PdfToolsLookup> {
  remembered ??= lookUp(world);
  return remembered;
}

/**
 * Forget the answer and look again next time, optionally in another world.
 * Used by the tests; the server never calls it.
 */
export function resetPdfToolLookup(another: Partial<LookupWorld> = {}): void {
  world = { ...defaultWorld(), ...another };
  remembered = null;
}

// ---------------------------------------------------------------------------
// Using them
// ---------------------------------------------------------------------------

/** Run one of the two programs. Not found or not startable: PdfToolsMissingError. */
export async function runPdfTool(
  tool: PdfTool,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const { command } = (await findPdfTools()).tools[tool];
  if (!command) throw new PdfToolsMissingError(tool, `${tool}: not found`);
  try {
    return await execFileAsync(command, args);
  } catch (err) {
    const code = couldNotStart(err);
    if (code) throw new PdfToolsMissingError(tool, `${tool}: ${code}`);
    throw err;
  }
}

/** Refuse, in words, before a reader starts work it cannot do. */
export async function requirePdfTools(): Promise<void> {
  const { tools } = await findPdfTools();
  const missing = PDF_TOOLS.filter((tool) => tools[tool].how === "missing");
  if (missing.length > 0) {
    throw new PdfToolsMissingError(missing[0]!, `not found: ${missing.join(", ")}`);
  }
}

/**
 * What GET /api/system/check answers, and nothing more: found or not and
 * HOW, never where. No path, no environment value.
 */
export interface SystemCheck {
  pdfinfo: { found: boolean; how: FoundHow };
  pdftoppm: { found: boolean; how: FoundHow };
  pathEntries: number;
  nixStore: { exists: boolean; hasPopplerFolder: boolean };
}

export async function systemCheck(): Promise<SystemCheck> {
  const found = await findPdfTools();
  const say = (tool: PdfTool) => ({
    found: found.tools[tool].how !== "missing",
    how: found.tools[tool].how,
  });
  return {
    pdfinfo: say("pdfinfo"),
    pdftoppm: say("pdftoppm"),
    pathEntries: found.pathEntries,
    nixStore: {
      exists: found.nixStore.exists,
      hasPopplerFolder: found.nixStore.popplerFolders > 0,
    },
  };
}

/**
 * Once, at start-up: how each program was found, and ONE loud line when one
 * is missing. The server still starts; the two readers refuse with a
 * sentence until it is there.
 */
export async function checkPdfToolsAtStartup(): Promise<void> {
  const check = await systemCheck();
  const facts = {
    pdfinfo: check.pdfinfo.how,
    pdftoppm: check.pdftoppm.how,
    pathEntries: check.pathEntries,
    nixStore: check.nixStore,
  };
  if (!check.pdfinfo.found || !check.pdftoppm.found) {
    logger.error(
      facts,
      "PDF tools missing: the room reader and the price-sheet reader will refuse",
    );
  } else {
    logger.info(facts, "PDF tools found");
  }
}
