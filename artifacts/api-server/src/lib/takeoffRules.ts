/**
 * The takeoff rules, in one place.
 *
 * Both the page (artifacts/panelbid) and the server use this file, so a rule
 * can never say one thing on screen and another on the proposal. It is pure:
 * no imports, no database, no browser. Every rule here has a test in
 * takeoffRules.test.ts.
 */

export type SheetSize = "4x4" | "4x8" | "4x10" | "4x12";
export type MoldingType = "aluminum" | "pvc";

export const SHEET_SIZES: SheetSize[] = ["4x4", "4x8", "4x10", "4x12"];

/** One room on the takeoff sheet (stored as JSON in takeoffs.room_rows). */
export interface RoomRow {
  roomName: string | null;
  roomNumber: string | null;
  /** Wall lengths as typed, e.g. "8 + 8 + 8.5, 12". */
  wallLengths: string;
  materialHeight: string | null;
  manufacturer: string | null;
  color: string | null;
  productCode: string | null;
  fireRating: string | null;
  moldingType: MoldingType | null;
  /**
   * The room's ceiling height. Used as the panel height, and marked "assumed
   * to ceiling", when the room has no panel height. Absent on rows saved
   * before update 1.
   */
  ceilingHeight?: string | null;
  /**
   * Inside and outside corner pieces he counted from the plans (update 2).
   * Null or absent: none typed. Never guessed.
   */
  insideCorners?: number | null;
  outsideCorners?: number | null;
  /**
   * "4x4 panel" ticked (true) or unticked (false) by hand. Null or absent: by
   * the product name (see fourByFourFor).
   */
  fourByFour?: boolean | null;
  /** The courses of a wall taller than 12 ft as he typed them ("10 + 4"). Null: suggested. */
  stackCourses?: string | null;
}

/** One sheet line on the takeoff sheet (stored as JSON in takeoffs.sheet_rows). */
export interface SheetRow {
  sheetsNeeded: number;
  sheetSize: SheetSize;
  pricePerSheet: number;
  /**
   * "suggested": the count follows the wall lengths. "typed" or absent: the
   * person's own count, which is never changed for them. (Rows saved before
   * update 1 have no mark, so they are his.)
   */
  sheetsSource?: "suggested" | "typed";
  /**
   * Typed molding count for this row's molding length, all kinds together:
   * how counts were typed before update 2. Null/absent = not typed.
   */
  moldingCount?: number | null;
  /**
   * The rules a SUGGESTED row was made under (CURRENT_RULES). A suggested row
   * without it was made before update 2 and keeps its saved count.
   */
  rules?: number;
  /** His typed counts by molding kind and length ("cap-8": 12), the same on every row. */
  moldingCounts?: Record<string, number> | null;
}

// ---------------------------------------------------------------------------
// Cost rules (the client's numbers)
// ---------------------------------------------------------------------------
export const OVERTIME_RATE = 34;
export const OVERTIME_AFTER_HOURS = 10;
export const TRAVEL_MULTIPLIER = 8 * 1.5;
export const HOTEL_NIGHTLY = 375;
export const PROFIT_FLAT = 800;
export const PROFIT_PER_DAY = 1000;
/** The client's own words: "Flat profit is for 8 and under." */
export const PROFIT_FLAT_MAX_SHEETS = 8;

/** True when the job's sheet count gets the flat profit (8 sheets and under). */
export function flatProfitApplies(totalSheets: number): boolean {
  return totalSheets <= PROFIT_FLAT_MAX_SHEETS;
}

// ---------------------------------------------------------------------------
// Wall lengths
// ---------------------------------------------------------------------------

// Lengths are added in sixteenths of an inch (whole numbers), so three walls
// of 5'-4" come to exactly 16 ft and never to 16.000000000000004, which would
// round up to one sheet too many.
const UNITS_PER_INCH = 16;
const UNITS_PER_FOOT = 12 * UNITS_PER_INCH;

const NUM = "(\\d+(?:\\.\\d+)?)";
const FRACTION = "(?:\\s+(\\d+)\\s*\\/\\s*(\\d+))?";
const FEET_MARK = "(?:'|ft\\.?|feet|foot)";
const INCH_MARK = "(?:\"|''|in\\.?|inch(?:es)?)";
const FEET_AND_INCHES = new RegExp(
  `^${NUM}\\s*${FEET_MARK}(?:\\s*-?\\s*${NUM}${FRACTION}\\s*${INCH_MARK}?)?$`,
  "i",
);
const INCHES_ONLY = new RegExp(`^${NUM}${FRACTION}\\s*${INCH_MARK}$`, "i");
// "12." (a number still being typed) reads as 12.
const PLAIN_NUMBER = /^\d+(?:\.\d*)?$/;
const PLAIN_NUMBERS = /^\d+(?:\.\d*)?(?:\s+\d+(?:\.\d*)?)+$/;

function straightQuotes(text: string): string {
  return text.replace(/[‘’′]/g, "'").replace(/[“”″]/g, '"');
}

function inchesFrom(
  whole: string | undefined,
  top: string | undefined,
  bottom: string | undefined,
): number | null {
  let inches = whole ? Number(whole) : 0;
  if (top !== undefined && bottom !== undefined) {
    if (Number(bottom) === 0) return null;
    inches += Number(top) / Number(bottom);
  }
  return inches;
}

/**
 * One length, in sixteenths of an inch: 8, 8.5, 8', 8'-6", 8' 6", 8 ft 6 in,
 * 8'-6 1/2", 96". A bare number is feet. Null when it is anything else.
 */
function readOneLength(raw: string): number | null {
  const text = straightQuotes(raw).trim();
  if (PLAIN_NUMBER.test(text)) return Math.round(Number(text) * UNITS_PER_FOOT);
  const feetInches = FEET_AND_INCHES.exec(text);
  if (feetInches) {
    const inches = inchesFrom(feetInches[2], feetInches[3], feetInches[4]);
    if (inches === null) return null;
    return Math.round(Number(feetInches[1]) * UNITS_PER_FOOT + inches * UNITS_PER_INCH);
  }
  const inchesOnly = INCHES_ONLY.exec(text);
  if (inchesOnly) {
    const inches = inchesFrom(inchesOnly[1], inchesOnly[2], inchesOnly[3]);
    if (inches === null) return null;
    return Math.round(inches * UNITS_PER_INCH);
  }
  return null;
}

export interface LengthRead {
  /** False when some part of the text could not be read. */
  ok: boolean;
  /** Total of the parts that could be read, in feet. */
  feet: number;
  /** The same total in sixteenths of an inch (a whole number). */
  units: number;
  /** Each wall that was read, in feet. */
  parts: number[];
  /** The parts that could not be read, as typed. */
  unread: string[];
}

/**
 * Wall lengths as typed: walls joined by "+", "," or ";". Each wall may be
 * plain feet ("8.5") or feet and inches ("8'-6\""). The old box added every
 * number it saw, so 8'-6" + 8'-6" came to 28 ft; it is 17 ft. Anything that
 * cannot be read is reported, never guessed.
 */
export function readWallLengths(input: string): LengthRead {
  const partsUnits: number[] = [];
  const unread: string[] = [];
  for (const piece of straightQuotes(input).split(/[+,;\n]/)) {
    const term = piece.trim();
    if (term === "") continue;
    const one = readOneLength(term);
    if (one !== null) {
      partsUnits.push(one);
    } else if (PLAIN_NUMBERS.test(term)) {
      // "8 8 8.5": plain numbers separated by spaces, as the old box allowed.
      for (const n of term.split(/\s+/)) {
        partsUnits.push(Math.round(Number(n) * UNITS_PER_FOOT));
      }
    } else {
      unread.push(term);
    }
  }
  const units = partsUnits.reduce((a, b) => a + b, 0);
  return {
    ok: unread.length === 0,
    feet: units / UNITS_PER_FOOT,
    units,
    parts: partsUnits.map((u) => u / UNITS_PER_FOOT),
    unread,
  };
}

/** The walls that could be read, each in feet. */
export function parseWallLengths(input: string): number[] {
  return readWallLengths(input).parts;
}

/** Total wall length in feet for one room (the parts that could be read). */
export function linearFootage(input: string): number {
  return readWallLengths(input).feet;
}

// ---------------------------------------------------------------------------
// Panel height
// ---------------------------------------------------------------------------

export interface HeightRead {
  /** The height in feet, or null. */
  feet: number | null;
  /** The text says the panel runs to the ceiling (no number of its own). */
  toCeiling: boolean;
  /** Something is typed but it is not a height we can read. */
  unread: boolean;
}

const TO_CEILING =
  /to (the )?(ceiling|clg\.?|deck|structure)|full[- ]?h(eigh)?t|floor to ceiling|open to structure/i;
const HEIGHT_WORDS =
  /(^|\s)(a\.?\s?f\.?\s?f\.?|high|height|ht\.?|wainscot|max\.?|typ\.?)(?=\s|$)/gi;

/** Read one height as typed ("8'-0\"", "9", "48\"", "to ceiling"). */
export function readHeight(input: string | null | undefined): HeightRead {
  const text = straightQuotes(input ?? "").trim();
  if (text === "") return { feet: null, toCeiling: false, unread: false };
  if (TO_CEILING.test(text)) return { feet: null, toCeiling: true, unread: false };
  const bare = text.replace(HEIGHT_WORDS, " ").trim();
  const units = readOneLength(bare);
  // A bare number over 20 ("48") is far more likely inches than feet: ask.
  const looksLikeInches = PLAIN_NUMBER.test(bare) && Number(bare) > 20;
  if (units === null || units <= 0 || looksLikeInches) {
    return { feet: null, toCeiling: false, unread: true };
  }
  return { feet: units / UNITS_PER_FOOT, toCeiling: false, unread: false };
}

export interface PanelHeight {
  feet: number | null;
  /** typed: the room's own panel height. ceiling: its ceiling height. */
  source: "typed" | "ceiling" | "none";
  /** True when no panel height was given and floor to ceiling was assumed. */
  assumed: boolean;
  /** Shown on the row: "assumed to ceiling", or what to type. */
  note: string;
}

/**
 * The panel height of a room. The client's rule: "The elevation pages or
 * notes on finish pages should tell you the height for the FRP, if not assume
 * FRP from floor to ceiling." So a room with no panel height uses its ceiling
 * height, and says "assumed to ceiling" on the row. A height that is typed
 * but cannot be read is never replaced by a guess.
 */
export function resolvePanelHeight(
  row: Pick<RoomRow, "materialHeight" | "ceilingHeight">,
): PanelHeight {
  const own = readHeight(row.materialHeight);
  if (own.feet !== null) {
    return { feet: own.feet, source: "typed", assumed: false, note: "" };
  }
  if (own.unread) {
    return {
      feet: null,
      source: "none",
      assumed: false,
      note: `can't read the height "${(row.materialHeight ?? "").trim()}": type it like 8' or 8'-6"`,
    };
  }
  const ceiling = readHeight(row.ceilingHeight);
  if (ceiling.feet !== null) {
    return own.toCeiling
      ? { feet: ceiling.feet, source: "ceiling", assumed: false, note: "to ceiling" }
      : { feet: ceiling.feet, source: "ceiling", assumed: true, note: "assumed to ceiling" };
  }
  return {
    feet: null,
    source: "none",
    assumed: false,
    note: own.toCeiling
      ? "to ceiling, but no ceiling height: type the ceiling height"
      : "no height: type the panel height, or the ceiling height",
  };
}

// ---------------------------------------------------------------------------
// Rounding each wall (update 2, his answer 4)
// ---------------------------------------------------------------------------

/**
 * How far each wall is rounded UP before the walls are added.
 *
 * His words: "im a little confused by this. we take each wall and round to the
 * nearest foot. if its a 7 foot wall we round to 8 feet and if the wall is 3
 * feet we round to 4 feet. at the end we round the total sheet count up to the
 * next full sheet"
 *
 * His two examples (7 -> 8, 3 -> 4) fit two readings: up to the next 4 ft, or
 * up to the next even foot. A 5 ft wall tells them apart (8 ft or 6 ft).
 */
export type WallRounding = 4 | 2;

/**
 * THE OPEN POINT, in one place. 4 = each wall up to the next 4 ft (a 5 ft wall
 * counts as 8 ft); 2 = up to the next even foot (a 5 ft wall counts as 6 ft).
 * ASSUMED 4 until he answers "A 5-foot wall: do you count it as 8 feet or as
 * 6?". His answer is a change to this one line (and its test).
 */
export const WALL_ROUND_UP_TO_FT: WallRounding = 4;

/** One wall in feet, rounded up to the step (8 stays 8; 7 -> 8; 3 -> 4). */
export function roundWallUp(feet: number, stepFt: WallRounding = WALL_ROUND_UP_TO_FT): number {
  const units = Math.round(feet * UNITS_PER_FOOT);
  return roundUnitsUp(units, stepFt) / UNITS_PER_FOOT;
}

function roundUnitsUp(units: number, stepFt: WallRounding): number {
  if (!(units > 0)) return 0;
  const step = stepFt * UNITS_PER_FOOT;
  return Math.ceil(units / step) * step;
}

/** The words the screen uses for the rounding, marked as assumed. */
export function wallRoundingWords(stepFt: WallRounding = WALL_ROUND_UP_TO_FT): string {
  return stepFt === 4
    ? "Each wall is rounded up to the next 4 ft before the walls are added (7 ft counts as 8 ft, 3 ft as 4 ft, 5 ft as 8 ft). ASSUMED: your examples also fit \"up to the next even foot\" (5 ft as 6 ft); we asked which you use."
    : "Each wall is rounded up to the next even foot before the walls are added (7 ft counts as 8 ft, 3 ft as 4 ft, 5 ft as 6 ft).";
}

export interface RoundedWall {
  typedFt: number;
  countedFt: number;
}

// ---------------------------------------------------------------------------
// Suggested sheets
// ---------------------------------------------------------------------------

/** Every sheet is 4 ft wide. */
export const SHEET_WIDTH_FT = 4;

/**
 * The shortest of his sheet sizes that covers the panel height:
 * 8 ft or less 4x8, above 8 up to 10 4x10, above 10 4x12.
 */
export function sheetSizeForHeight(heightFt: number): SheetSize {
  if (heightFt <= 8) return "4x8";
  if (heightFt <= 10) return "4x10";
  return "4x12";
}

function plain(n: number): string {
  return String(Number(n.toFixed(2)));
}

/** A height or length for people to read: "8 ft", "3 ft 8 in". */
export function feetText(feet: number): string {
  const units = Math.round(feet * UNITS_PER_FOOT);
  const whole = Math.floor(units / UNITS_PER_FOOT);
  const inches = (units - whole * UNITS_PER_FOOT) / UNITS_PER_INCH;
  return inches === 0 ? `${whole} ft` : `${whole} ft ${plain(inches)} in`;
}

/** How a room is named on the proposal and the material list: "Kitchen 101". */
export function roomLabel(
  row: Pick<RoomRow, "roomName" | "roomNumber">,
  index: number,
): string {
  const name = (row.roomName ?? "").trim();
  const num = (row.roomNumber ?? "").trim();
  if (name && num) {
    const alreadyThere = name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .includes(num.toLowerCase());
    return alreadyThere ? name : `${name} ${num}`;
  }
  if (name) return name;
  if (num) return `Room ${num}`;
  return `Room ${index + 1}`;
}

/** His longest sheet. A panel taller than this is stacked. */
export const LONGEST_SHEET_FT = 12;

/**
 * A panel this high or lower is "4' tall" material. His words (answer 3):
 * "for 4' tall we put the 4x8 on its side but for products like marlite
 * symetrix it comes in a 4x4 panel. to my knowledge that is the only panel
 * type that comes in a 4x4."
 */
export const ON_SIDE_MAX_FT = 4;

/** What one 4x8 on its side covers along the wall. */
export const ON_SIDE_COVER_FT = 8;

/**
 * The product he names as coming in a 4x4 ("marlite symetrix"). Matched on the
 * room's manufacturer and product boxes; the match is our reading, so the row
 * says "assumed" and he can untick it.
 */
const FOUR_BY_FOUR_PRODUCT = /symm?etrix/i;

export interface FourByFour {
  /** True when the room is counted in 4x4 panels. */
  on: boolean;
  /** ticked / unticked: his own tick. product: matched on the product name. */
  source: "ticked" | "unticked" | "product" | "none";
  /** The product text that matched, when source is "product". */
  match: string | null;
}

export function fourByFourFor(
  row: Pick<RoomRow, "fourByFour" | "manufacturer" | "productCode">,
): FourByFour {
  if (row.fourByFour === true) return { on: true, source: "ticked", match: null };
  if (row.fourByFour === false) return { on: false, source: "unticked", match: null };
  for (const text of [row.productCode, row.manufacturer]) {
    const hit = FOUR_BY_FOUR_PRODUCT.exec(text ?? "");
    if (hit) return { on: true, source: "product", match: hit[0] };
  }
  return { on: false, source: "none", match: null };
}

/** One kind of sheet a room takes (a stacked wall takes one per course). */
export interface SheetPart {
  size: SheetSize;
  /** A 4x8 laid on its side (4 ft tall, 8 ft along the wall). */
  onSide: boolean;
  /** The course height in a stack, else null. */
  courseFt: number | null;
  /** How much wall one sheet covers along the floor, in feet. */
  coverFt: number;
  /** Counted wall ÷ cover. NOT rounded: the job rounds once per size. */
  sheets: number;
  /** The panel is 4 ft tall or less (two caps a sheet). */
  fourFtTall: boolean;
}

export type RoomLayout = "upright" | "onSide" | "fourByFour" | "stack";

export interface RoomStack {
  /** Course heights from the floor up, in feet. */
  courses: number[];
  /** True when he typed the courses. */
  typed: boolean;
  /** The courses in words: "10 ft: 4x10 upright + 4 ft: 4x8 on its side". */
  text: string;
  /** How the stack was chosen, ending with "your call". */
  note: string;
}

export interface RoomSuggestion {
  wall: LengthRead;
  /** Each wall as typed and as counted (rounded up). */
  walls: RoundedWall[];
  /** The rounded walls added up, in feet. */
  countedFeet: number;
  /** "7 ft counted as 8 ft + 3 ft counted as 4 ft = 12 ft". */
  wallWorking: string;
  height: PanelHeight;
  layout: RoomLayout | null;
  parts: SheetPart[];
  /** All the room's sheets (not rounded; a 4x8 on its side may be 1.5). Null when none can be suggested. */
  sheets: number | null;
  /** The room's sheet size (the first course of a stack). Null without a height. */
  sheetSize: SheetSize | null;
  /** The working, in words. */
  arithmetic: string;
  /** Why there is no suggestion, in words. Null when there is one. */
  problem: string | null;
  /** Something to check about a suggestion that IS given. Null when nothing. */
  warning: string | null;
  /** Where this room's count goes beyond his words: shown as "assumed". */
  assumed: string[];
  fourByFour: FourByFour;
  /** The courses of a wall taller than 12 ft, else null. */
  stack: RoomStack | null;
}

export interface SuggestOptions {
  /** The wall rounding to use. Defaults to WALL_ROUND_UP_TO_FT. */
  rounding?: WallRounding;
  /**
   * The sheet length the rest of the job uses (8, 10 or 12), to start a stack
   * from. Null or absent: none, so a wall taller than 12 ft asks.
   */
  jobSheetLengthFt?: number | null;
}

function sheetsNoun(n: number, word = "sheet"): string {
  return n === 1 ? word : `${word}s`;
}

/**
 * The stack he would start from (answer 2): "if the restr of the job is 8' we
 * would start with an 8 then stack 8s to reach the desired height. if we have
 * 10s on the job but need to hit 14' then it would be a 10' vertical and an 8'
 * horizontal." So: the job's sheet length upright, then the same length again
 * while more than 4 ft is left, and a 4x8 on its side for the last 4 ft or
 * less. Course heights in feet. Always shown as "your call".
 */
export function suggestStack(heightFt: number, jobSheetLengthFt: number): number[] {
  const courses: number[] = [];
  let left = heightFt;
  while (left > 0 && courses.length < 20) {
    if (courses.length > 0 && left <= ON_SIDE_MAX_FT) {
      courses.push(ON_SIDE_MAX_FT);
      break;
    }
    courses.push(jobSheetLengthFt);
    left -= jobSheetLengthFt;
  }
  return courses;
}

/** A course height in a stack, as a sheet: 4 ft or less is a 4x8 on its side. */
function courseSheet(courseFt: number): { size: SheetSize; onSide: boolean } {
  if (courseFt <= ON_SIDE_MAX_FT) return { size: "4x8", onSide: true };
  return { size: sheetSizeForHeight(courseFt), onSide: false };
}

function courseWords(courseFt: number): string {
  const { size, onSide } = courseSheet(courseFt);
  if (onSide) return `${feetText(courseFt)}: 4x8 on its side`;
  const full = Number(size.split("x")[1]);
  return `${feetText(courseFt)}: ${size} upright${courseFt < full ? ` (cut to ${feetText(courseFt)})` : ""}`;
}

/** Courses as he types them: "10 + 4", "8, 8". */
export function readCourses(text: string): { ok: true; courses: number[] } | { ok: false; reason: string } {
  const courses: number[] = [];
  for (const piece of straightQuotes(text).split(/[+,;]/)) {
    const term = piece.trim();
    if (term === "") continue;
    const units = readOneLength(term);
    if (units === null || units <= 0) {
      return { ok: false, reason: `can't read "${term}" in the courses: type them like 10 + 4` };
    }
    const feet = units / UNITS_PER_FOOT;
    if (feet > LONGEST_SHEET_FT) {
      return { ok: false, reason: `a course of ${feetText(feet)} is taller than a ${LONGEST_SHEET_FT} ft sheet` };
    }
    courses.push(feet);
  }
  if (courses.length === 0) return { ok: false, reason: "no courses typed" };
  return { ok: true, courses };
}

function partOf(
  size: SheetSize,
  onSide: boolean,
  courseFt: number | null,
  countedUnits: number,
  fourFtTall: boolean,
): SheetPart {
  const coverFt = onSide ? ON_SIDE_COVER_FT : SHEET_WIDTH_FT;
  return {
    size,
    onSide,
    courseFt,
    coverFt,
    sheets: countedUnits / (coverFt * UNITS_PER_FOOT),
    fourFtTall,
  };
}

function partWorking(part: SheetPart, countedFeet: number): string {
  const n = part.sheets;
  if (part.size === "4x4") {
    return `${plain(countedFeet)} ft ÷ ${part.coverFt} ft a panel = ${plain(n)} ${sheetsNoun(n, "panel")} of 4x4`;
  }
  const how = part.onSide ? " (4x8 on its side)" : "";
  return `${plain(countedFeet)} ft ÷ ${part.coverFt} ft a sheet${how} = ${plain(n)} ${sheetsNoun(n)} of ${part.size}`;
}

/**
 * Suggested sheets for one room.
 *
 * - Each wall is rounded up (WALL_ROUND_UP_TO_FT) and the rounded walls added.
 *   The walls are measured straight through doors and windows ("Yes we
 *   measure through windows and doors to get our waste"), so NO waste is
 *   added and NO opening is taken out.
 * - A panel 4 ft tall or less: a 4x8 on its side covers 8 ft of wall; a 4x4
 *   product covers 4 ft a panel.
 * - Above 4 ft up to 12 ft: one upright sheet per 4 ft of wall.
 * - Taller than 12 ft: stacked courses (see suggestStack), never a silent count.
 * - The room's count is NOT rounded here: the job rounds once per sheet size.
 */
export function suggestRoom(row: RoomRow, options: SuggestOptions = {}): RoomSuggestion {
  const rounding = options.rounding ?? WALL_ROUND_UP_TO_FT;
  const wall = readWallLengths(row.wallLengths);
  const height = resolvePanelHeight(row);
  const fourByFour = fourByFourFor(row);
  const walls: RoundedWall[] = wall.parts.map((ft) => ({
    typedFt: ft,
    countedFt: roundUnitsUp(Math.round(ft * UNITS_PER_FOOT), rounding) / UNITS_PER_FOOT,
  }));
  const countedUnits = walls.reduce((sum, w) => sum + Math.round(w.countedFt * UNITS_PER_FOOT), 0);
  const countedFeet = countedUnits / UNITS_PER_FOOT;
  const wallWorking =
    walls.length === 0
      ? ""
      : `${walls
          .map((w) =>
            w.countedFt === w.typedFt
              ? feetText(w.typedFt)
              : `${feetText(w.typedFt)} counted as ${feetText(w.countedFt)}`,
          )
          .join(" + ")} = ${feetText(countedFeet)}`;
  const base = {
    wall,
    walls,
    countedFeet,
    wallWorking,
    height,
    fourByFour,
    warning: null,
  };
  const none = (problem: string, sheetSize: SheetSize | null = null): RoomSuggestion => ({
    ...base,
    layout: null,
    parts: [],
    sheets: null,
    sheetSize,
    arithmetic: "",
    problem,
    assumed: [],
    stack: null,
  });

  const h = height.feet;
  const plainSize = h !== null ? sheetSizeForHeight(h) : null;
  if (!wall.ok) return none(`can't read "${wall.unread[0]}" in the wall lengths`, plainSize);
  if (wall.units <= 0) return none("no wall length typed", plainSize);
  if (h === null) return none(height.note);

  const assumed: string[] = [];

  // A panel 4 ft tall or less.
  if (h <= ON_SIDE_MAX_FT) {
    if (fourByFour.on) {
      if (fourByFour.source === "product") {
        assumed.push(
          `4x4 panels because the product says "${fourByFour.match}" (assumed: untick 4x4 if this room takes 4x8s)`,
        );
      }
      const part = partOf("4x4", false, null, countedUnits, true);
      return {
        ...base,
        layout: "fourByFour",
        parts: [part],
        sheets: part.sheets,
        sheetSize: "4x4",
        arithmetic: partWorking(part, countedFeet),
        problem: null,
        assumed,
        stack: null,
      };
    }
    const part = partOf("4x8", true, null, countedUnits, true);
    return {
      ...base,
      layout: "onSide",
      parts: [part],
      sheets: part.sheets,
      sheetSize: "4x8",
      arithmetic: partWorking(part, countedFeet),
      problem: null,
      assumed,
      stack: null,
    };
  }

  // A 4x4 ticked by hand on a taller panel: no rule for stacking 4x4s.
  if (fourByFour.source === "ticked") {
    return none(
      `4x4 is ticked, but the panel is ${feetText(h)} high: how you stack 4x4 panels above 4 ft is not a rule we have. Untick 4x4, or type the sheet count yourself`,
      plainSize,
    );
  }

  // Up to his longest sheet: one upright sheet per 4 ft of wall.
  if (h <= LONGEST_SHEET_FT) {
    const part = partOf(sheetSizeForHeight(h), false, null, countedUnits, false);
    return {
      ...base,
      layout: "upright",
      parts: [part],
      sheets: part.sheets,
      sheetSize: part.size,
      arithmetic: partWorking(part, countedFeet),
      problem: null,
      assumed,
      stack: null,
    };
  }

  // Taller than 12 ft: stacked courses.
  const typedText = (row.stackCourses ?? "").trim();
  let courses: number[];
  let typed: boolean;
  let note: string;
  if (typedText !== "") {
    const read = readCourses(typedText);
    if (!read.ok) return none(read.reason, "4x12");
    courses = read.courses;
    typed = true;
    note = "your courses: change them if you would stack it differently";
  } else {
    const start = options.jobSheetLengthFt ?? null;
    if (start === null) {
      return none(
        `the panel is ${feetText(h)} high, taller than a ${LONGEST_SHEET_FT} ft sheet, and the job has no other sheet size yet to start the stack from: type the courses (for example 10 + 4)`,
        "4x12",
      );
    }
    courses = suggestStack(h, start);
    typed = false;
    note = `the rest of the job uses ${start} ft sheets, so it starts with a ${start} ft sheet: your call: change it if you would stack it differently`;
  }
  const reach = courses.reduce((a, b) => a + b, 0);
  if (reach < h - 1e-9) {
    return none(
      `the courses reach ${feetText(reach)}, but the panel is ${feetText(h)} high: add a course`,
      "4x12",
    );
  }
  const parts = courses.map((c) => {
    const { size, onSide } = courseSheet(c);
    return partOf(size, onSide, c, countedUnits, false);
  });
  const sheets = parts.reduce((sum, p) => sum + p.sheets, 0);
  const text = courses.map(courseWords).join(" + ");
  return {
    ...base,
    layout: "stack",
    parts,
    sheets,
    sheetSize: parts[0]!.size,
    arithmetic: parts
      .map((p, i) => `course ${i + 1}, ${courseWords(p.courseFt!)}: ${partWorking(p, countedFeet)}`)
      .join("; "),
    problem: null,
    assumed,
    stack: { courses, typed, text, note },
  };
}

export interface JobSuggestion {
  rooms: RoomSuggestion[];
  /** Suggested sheets per size: the rooms' sheets added, rounded up ONCE per size. */
  bySize: Record<SheetSize, number>;
  /** The same before rounding. */
  exactBySize: Record<SheetSize, number>;
  /** The working per size: "4x8: 1.5 + 1.5 = 3 sheets". */
  sizeWorking: Partial<Record<SheetSize, string>>;
  /** The sheet length the job's walls of 12 ft or less use (the longest), or null. */
  jobSheetLengthFt: number | null;
}

const zeroBySize = (): Record<SheetSize, number> => ({ "4x4": 0, "4x8": 0, "4x10": 0, "4x12": 0 });

/**
 * The job's suggested sheets. His words: "at the end we round the total sheet
 * count up to the next full sheet": the rooms' sheets are added per size and
 * rounded up once, at the end.
 */
export function suggestSheets(roomRows: RoomRow[], options: { rounding?: WallRounding } = {}): JobSuggestion {
  // First the walls of 12 ft or less: they tell a tall wall which sheet the
  // rest of the job uses ("depending on the rest of the job").
  const first = roomRows.map((row) => suggestRoom(row, { rounding: options.rounding }));
  let jobSheetLengthFt: number | null = null;
  for (const r of first) {
    if (r.layout !== "upright" && r.layout !== "onSide") continue;
    const len = Number(r.parts[0]!.size.split("x")[1]);
    jobSheetLengthFt = jobSheetLengthFt === null ? len : Math.max(jobSheetLengthFt, len);
  }
  const rooms = roomRows.map((row, i) => {
    const h = first[i]!.height.feet;
    return h !== null && h > LONGEST_SHEET_FT
      ? suggestRoom(row, { rounding: options.rounding, jobSheetLengthFt })
      : first[i]!;
  });
  const exactBySize = zeroBySize();
  const terms: Record<SheetSize, number[]> = { "4x4": [], "4x8": [], "4x10": [], "4x12": [] };
  for (const r of rooms) {
    for (const p of r.parts) {
      exactBySize[p.size] += p.sheets;
      terms[p.size].push(p.sheets);
    }
  }
  const bySize = zeroBySize();
  const sizeWorking: Partial<Record<SheetSize, string>> = {};
  for (const size of SHEET_SIZES) {
    const exact = exactBySize[size];
    if (!(exact > 0)) continue;
    const count = Math.ceil(exact - 1e-9);
    bySize[size] = count;
    const sum = terms[size].length > 1 ? `${terms[size].map(plain).join(" + ")} = ` : "";
    sizeWorking[size] =
      count === exact
        ? `${size}: ${sum}${plain(count)} ${sheetsNoun(count)}`
        : `${size}: ${sum}${plain(exact)}, rounded up to ${count} ${sheetsNoun(count)}`;
  }
  return { rooms, bySize, exactBySize, sizeWorking, jobSheetLengthFt };
}

/** The rules a suggested row was made under. Rows made before update 2 have none. */
export const CURRENT_RULES = 2;

/** Any suggested row, whichever rules it was made under. */
export function isSuggested(row: SheetRow): boolean {
  return row.sheetsSource === "suggested";
}

/** A suggested row made under the current rules: its count follows the walls. */
export function followsWalls(row: SheetRow): boolean {
  return row.sheetsSource === "suggested" && row.rules === CURRENT_RULES;
}

/**
 * A row suggested under the earlier rules (saved before update 2). It keeps
 * the count it was saved with until he chooses the new count: an old job
 * opens, saves and prints with the numbers it was saved with.
 */
export function suggestedEarlier(row: SheetRow): boolean {
  return row.sheetsSource === "suggested" && row.rules !== CURRENT_RULES;
}

/**
 * Bring every SUGGESTED sheet row made under the current rules up to date
 * with the rooms. Rows the person typed, and rows suggested under the earlier
 * rules, are returned untouched. No row is added or removed. The server runs
 * this on every save and before every proposal, so a stale suggested count is
 * never stored or printed.
 */
export function refreshSuggestedRows(roomRows: RoomRow[], sheetRows: SheetRow[]): SheetRow[] {
  const bySize = suggestSheets(roomRows).bySize;
  const given = new Set<SheetSize>();
  return sheetRows.map((row) => {
    if (!followsWalls(row)) return row;
    const count = given.has(row.sheetSize) ? 0 : bySize[row.sheetSize];
    given.add(row.sheetSize);
    return row.sheetsNeeded === count ? row : { ...row, sheetsNeeded: count };
  });
}

/**
 * The sheet rows after the rooms changed from prevRooms to nextRooms.
 *
 * - Suggested rows (current rules) follow the wall lengths.
 * - A size whose suggestion changed and that has no row at all gets a
 *   suggested row.
 * - A row the person typed is never changed, and no suggested row is added
 *   beside it for the same size. The same goes for a row suggested under the
 *   earlier rules: it keeps its saved count until he picks the new one.
 * - A suggested row the person deleted does not come back until the
 *   suggestion for that size itself changes.
 * - A suggested row with nothing typed in it goes away when its rooms do.
 * - A new suggested row takes its place in sheet-size order (4x4, 4x8, 4x10,
 *   4x12), so rows do not jump about while a wall length is being typed.
 */
export function applySuggestions(
  prevRooms: RoomRow[],
  nextRooms: RoomRow[],
  sheetRows: SheetRow[],
): SheetRow[] {
  const before = suggestSheets(prevRooms).bySize;
  const after = suggestSheets(nextRooms).bySize;
  const rows = [...sheetRows];
  for (const size of SHEET_SIZES) {
    if (before[size] === after[size] || after[size] <= 0) continue;
    if (!rows.some((r) => r.sheetSize === size)) {
      const row: SheetRow = {
        sheetsNeeded: after[size],
        sheetSize: size,
        pricePerSheet: 0,
        sheetsSource: "suggested",
        rules: CURRENT_RULES,
      };
      const bigger = rows.findIndex(
        (r) => SHEET_SIZES.indexOf(r.sheetSize) > SHEET_SIZES.indexOf(size),
      );
      if (bigger === -1) rows.push(row);
      else rows.splice(bigger, 0, row);
    }
  }
  return refreshSuggestedRows(nextRooms, rows).filter(
    (r) =>
      !(
        followsWalls(r) &&
        r.sheetsNeeded === 0 &&
        !(r.pricePerSheet > 0) &&
        r.moldingCount == null
      ),
  );
}

/** What a room spec gives a new takeoff row. */
export interface RoomSpecForDraft {
  roomName: string | null;
  roomNumber: string | null;
  materialHeight: string | null;
  ceilingHeight: string | null;
  manufacturer: string | null;
  color: string | null;
  productCode: string | null;
  fireRating: string | null;
}

/**
 * The room rows of a new takeoff, from the confirmed room specs. The ceiling
 * height is carried beside the panel height, never copied into it: a room
 * with no panel height shows "assumed to ceiling" instead of a silent number.
 */
export function draftRoomRows(specs: RoomSpecForDraft[]): RoomRow[] {
  return specs.map((s) => ({
    roomName: s.roomName,
    roomNumber: s.roomNumber,
    wallLengths: "",
    materialHeight: s.materialHeight,
    ceilingHeight: s.ceilingHeight,
    manufacturer: s.manufacturer,
    color: s.color,
    productCode: s.productCode,
    fireRating: s.fireRating,
    moldingType: null,
  }));
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

/** Square footage of a sheet size, e.g. "4x8" -> 32. */
export function sheetAreaSqft(size: SheetSize): number {
  const [w, l] = size.split("x").map(Number);
  return (w ?? 0) * (l ?? 0);
}

/**
 * Price per sheet for a line picked from a price sheet: the printed price per
 * sheet when there is one, else price per square foot x the sheet's area,
 * rounded to cents. Null when the line has neither.
 */
export function resolvePricePerSheet(
  item: { pricePerSheet: number | null; pricePerSqft: number | null },
  rowSize: SheetSize,
): number | null {
  if (item.pricePerSheet != null) return item.pricePerSheet;
  if (item.pricePerSqft != null) {
    return Math.round(item.pricePerSqft * sheetAreaSqft(rowSize) * 100) / 100;
  }
  return null;
}

export function totalSheets(sheetRows: SheetRow[]): number {
  return sheetRows.reduce((sum, r) => sum + r.sheetsNeeded, 0);
}

// ---------------------------------------------------------------------------
// Glue and moldings
// ---------------------------------------------------------------------------

/** The client's own words: "Glue is per sheet, one bucket does 12 sheets of any height." */
export const GLUE_SHEETS_PER_BUCKET = 12;

/** Buckets of glue: total sheets ÷ 12, rounded up. */
export function glueBuckets(sheetCount: number): { buckets: number; arithmetic: string } {
  if (!(sheetCount > 0)) return { buckets: 0, arithmetic: "no sheets, so no glue" };
  const buckets = Math.ceil(sheetCount / GLUE_SHEETS_PER_BUCKET);
  const noun = buckets === 1 ? "bucket" : "buckets";
  const start = `${plain(sheetCount)} sheets ÷ ${GLUE_SHEETS_PER_BUCKET} a bucket = `;
  const arithmetic =
    sheetCount % GLUE_SHEETS_PER_BUCKET === 0
      ? `${start}${buckets} ${noun}`
      : `${start}${plain(sheetCount / GLUE_SHEETS_PER_BUCKET)}, rounded up to ${buckets} ${noun}`;
  return { buckets, arithmetic };
}

/** Moldings come in two lengths. */
export type MoldingLength = 8 | 10;
export const MOLDING_LENGTHS: MoldingLength[] = [8, 10];

/**
 * The client's own words: "Moldings come in 8' and 10' lengths and the kind
 * you use is dependent on the height of the sheet. 8' high or less for 8'
 * molding, and above 8' is the 10' molding."
 */
export function moldingLengthForSheet(size: SheetSize): MoldingLength {
  const sheetHeightFt = Number(size.split("x")[1]);
  return sheetHeightFt <= 8 ? 8 : 10;
}

export interface MoldingLine {
  lengthFt: MoldingLength;
  /** Sheets that take this molding length. */
  sheets: number;
  /** The starting suggestion: one molding per sheet. AN ASSUMPTION, not his rule. */
  suggested: number;
  /** The count to use: what he typed, else the suggestion. */
  count: number;
  /** True when he typed the count himself. */
  typed: boolean;
}

/**
 * Moldings by length, as counted before update 2 (one per sheet, or a count
 * typed per length). Kept so a takeoff saved before update 2 still shows the
 * count he typed; new counts are by kind (see moldingsByKind).
 *
 * Moldings by length. The LENGTH is the client's rule. He has not said how
 * many moldings a job takes, so no count rule is invented here: the count is
 * whatever he types, and until he types one the page shows one per sheet,
 * labelled as an assumption to confirm.
 *
 * A typed count is kept on the sheet rows of that length (the same number on
 * each), so it is saved with the takeoff without any change to the database.
 */
export function moldingLines(sheetRows: SheetRow[]): MoldingLine[] {
  return MOLDING_LENGTHS.map((lengthFt) => {
    const mine = sheetRows.filter((r) => moldingLengthForSheet(r.sheetSize) === lengthFt);
    const sheets = mine.reduce((sum, r) => sum + r.sheetsNeeded, 0);
    const typedRow = mine.find((r) => r.moldingCount != null);
    const typed = typedRow?.moldingCount ?? null;
    return {
      lengthFt,
      sheets,
      suggested: sheets,
      count: typed !== null ? typed : sheets,
      typed: typed !== null,
    };
  });
}

/** A row with this typed molding count; "not typed" leaves no trace on the row. */
function withMoldingCount(row: SheetRow, count: number | null): SheetRow {
  if (count === null) {
    if (!("moldingCount" in row)) return row;
    const { moldingCount: _cleared, ...rest } = row;
    return rest;
  }
  return row.moldingCount === count ? row : { ...row, moldingCount: count };
}

/** Type (or, with null, clear) the molding count for one length. */
export function setMoldingCount(
  sheetRows: SheetRow[],
  lengthFt: MoldingLength,
  count: number | null,
): SheetRow[] {
  return sheetRows.map((r) =>
    moldingLengthForSheet(r.sheetSize) === lengthFt ? withMoldingCount(r, count) : r,
  );
}

/** Make every sheet row of a length carry that length's typed count (and every row his counts by kind). */
export function tidyMoldingCounts(sheetRows: SheetRow[]): SheetRow[] {
  const typed = new Map<MoldingLength, number | null>();
  for (const line of moldingLines(sheetRows)) {
    typed.set(line.lengthFt, line.typed ? line.count : null);
  }
  const tidy = sheetRows.map((r) =>
    withMoldingCount(r, typed.get(moldingLengthForSheet(r.sheetSize)) ?? null),
  );
  // His counts by kind (update 2): the same on every row.
  return withKindCounts(tidy, typedKindCounts(tidy));
}

// ---------------------------------------------------------------------------
// Moldings by kind (update 2, his answer 1)
// ---------------------------------------------------------------------------

/**
 * His words: "Molding counts are based off of a few factors. Sheet height, 4'
 * tall material needs cap on top and bottom (a full stick each) one divider,
 * and inside/outside corners as needed based off plans. taller than 4' is the
 * same except cap is 1 stick for top and bottom rather than two."
 */
export type MoldingKind = "cap" | "divider" | "insideCorner" | "outsideCorner";
export const MOLDING_KINDS: MoldingKind[] = ["cap", "divider", "insideCorner", "outsideCorner"];
export const MOLDING_KIND_NAMES: Record<MoldingKind, string> = {
  cap: "Cap",
  divider: "Divider",
  insideCorner: "Inside corner",
  outsideCorner: "Outside corner",
};

/** Cap sticks a sheet: two for 4 ft material, one when the panel is taller. */
export const CAPS_PER_SHEET_4FT = 2;
export const CAPS_PER_SHEET_TALLER = 1;
/** "one divider". */
export const DIVIDERS_PER_SHEET = 1;

/** The key a kind and length are stored under: "cap-8", "insideCorner-10". */
export function moldingKey(kind: MoldingKind, lengthFt: MoldingLength): string {
  return `${kind}-${lengthFt}`;
}

/** The words that say how far the per-sheet counts go beyond his words. */
export const MOLDING_PER_SHEET_ASSUMED =
  "Caps and dividers are counted per sheet: 2 caps a sheet for 4 ft material, 1 when taller, 1 divider a sheet. \"Per sheet\" is our reading of your words (assumed).";

export interface KindLine {
  key: string;
  kind: MoldingKind;
  lengthFt: MoldingLength;
  /** What his rule gives (corners: what he typed per room). */
  suggested: number;
  /** What he typed over it, else the suggestion. */
  count: number;
  typed: boolean;
  /** The working, in words. */
  working: string;
  /** Where this line goes beyond his words. */
  assumed: string[];
}

export interface LegacyMoldingLine {
  lengthFt: MoldingLength;
  count: number;
}

export interface MoldingTakeoff {
  /** Lines with a count (or a typed count), by length then kind. */
  lines: KindLine[];
  /** Rooms (or corners) left out of the counts, and why, in words. */
  notCounted: string[];
  /**
   * Counts typed per LENGTH before update 2 (all kinds together). They are
   * his and are kept: the kind lines of that length are not used while one
   * is there.
   */
  legacy: LegacyMoldingLine[];
}

/** His typed counts by kind (the same object is kept on every sheet row). */
function typedKindCounts(sheetRows: SheetRow[]): Map<string, number> {
  const typed = new Map<string, number>();
  for (const row of sheetRows) {
    for (const [key, value] of Object.entries(row.moldingCounts ?? {})) {
      if (!typed.has(key) && typeof value === "number") typed.set(key, value);
    }
  }
  return typed;
}

function cornerCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Moldings by kind and length, from the rooms (each room knows whether its
 * sheets are 4 ft material or taller), with his typed counts over them.
 *
 * Not counted, and said so (not his rule yet): moldings on 12 ft sheets, and
 * on stacked walls above 12 ft (caps, the joint between courses, corners).
 */
export function moldingsByKind(
  roomRows: RoomRow[],
  sheetRows: SheetRow[],
  options: { rounding?: WallRounding } = {},
): MoldingTakeoff {
  const job = suggestSheets(roomRows, options);
  const typed = typedKindCounts(sheetRows);
  const notCounted: string[] = [];

  type Acc = {
    caps4: number;
    capsTall: number;
    sheets: number;
    fourByFour: boolean;
    inside: { label: string; n: number }[];
    outside: { label: string; n: number }[];
  };
  const acc: Record<MoldingLength, Acc> = {
    8: { caps4: 0, capsTall: 0, sheets: 0, fourByFour: false, inside: [], outside: [] },
    10: { caps4: 0, capsTall: 0, sheets: 0, fourByFour: false, inside: [], outside: [] },
  };

  roomRows.forEach((row, index) => {
    const s = job.rooms[index]!;
    const label = roomLabel(row, index);
    const inside = cornerCount(row.insideCorners);
    const outside = cornerCount(row.outsideCorners);
    const corners =
      inside + outside > 0
        ? ` The corners typed (${inside} inside, ${outside} outside) are not in the counts either.`
        : "";
    if (s.layout === null) {
      if (inside + outside > 0) {
        notCounted.push(
          `${label}: corners typed (${inside} inside, ${outside} outside) are not counted until the room has a sheet count (${s.problem}).`,
        );
      }
      return;
    }
    if (s.layout === "stack") {
      notCounted.push(
        `${label}: no moldings counted. A stacked wall above ${LONGEST_SHEET_FT} ft: its caps, the joint between courses and its corners are not a rule we have yet. Count them yourself.${corners}`,
      );
      return;
    }
    const part = s.parts[0]!;
    if (part.size === "4x12") {
      notCounted.push(
        `${label}: no moldings counted. 12 ft sheets: which molding goes on a 12 ft sheet is not a rule we have yet (moldings come in 8 ft and 10 ft). Count them yourself.${corners}`,
      );
      return;
    }
    const a = acc[moldingLengthForSheet(part.size)];
    if (part.fourFtTall) a.caps4 += part.sheets;
    else a.capsTall += part.sheets;
    a.sheets += part.sheets;
    if (part.size === "4x4") a.fourByFour = true;
    if (inside > 0) a.inside.push({ label, n: inside });
    if (outside > 0) a.outside.push({ label, n: outside });
  });

  const lines: KindLine[] = [];
  const push = (
    kind: MoldingKind,
    lengthFt: MoldingLength,
    suggested: number,
    working: string,
    assumed: string[],
  ) => {
    const key = moldingKey(kind, lengthFt);
    const mine = typed.get(key);
    if (!(suggested > 0) && mine === undefined) return;
    lines.push({
      key,
      kind,
      lengthFt,
      suggested,
      count: mine !== undefined ? mine : suggested,
      typed: mine !== undefined,
      working,
      assumed,
    });
  };

  for (const lengthFt of MOLDING_LENGTHS) {
    const a = acc[lengthFt];
    const fourByFourNote = a.fourByFour
      ? ["4x4 panels are counted like other 4 ft material (2 caps and 1 divider a panel): assumed"]
      : [];

    // Caps.
    const capExact = CAPS_PER_SHEET_4FT * a.caps4 + CAPS_PER_SHEET_TALLER * a.capsTall;
    const caps = Math.ceil(capExact - 1e-9);
    const capTerms = [
      ...(a.caps4 > 0 ? [`${CAPS_PER_SHEET_4FT} a sheet × ${plain(a.caps4)} ${sheetsNoun(a.caps4)} 4 ft tall`] : []),
      ...(a.capsTall > 0
        ? [`${CAPS_PER_SHEET_TALLER} a sheet × ${plain(a.capsTall)} ${sheetsNoun(a.capsTall)} taller than 4 ft`]
        : []),
    ];
    push(
      "cap",
      lengthFt,
      caps,
      capTerms.length === 0
        ? ""
        : `${capTerms.join(" + ")} = ${caps === capExact ? caps : `${plain(capExact)}, rounded up to ${caps}`}`,
      fourByFourNote,
    );

    // Dividers.
    const dividers = Math.ceil(DIVIDERS_PER_SHEET * a.sheets - 1e-9);
    push(
      "divider",
      lengthFt,
      dividers,
      a.sheets > 0
        ? `${DIVIDERS_PER_SHEET} a sheet × ${plain(a.sheets)} ${sheetsNoun(a.sheets)} = ${
            dividers === a.sheets ? dividers : `${plain(a.sheets)}, rounded up to ${dividers}`
          }`
        : "",
      fourByFourNote,
    );

    // Corners: only what he typed per room ("as needed based off plans").
    for (const [kind, list] of [
      ["insideCorner", a.inside],
      ["outsideCorner", a.outside],
    ] as const) {
      const total = list.reduce((sum, c) => sum + c.n, 0);
      push(
        kind,
        lengthFt,
        total,
        list.length > 0 ? `typed per room: ${list.map((c) => `${c.label} ${c.n}`).join(" + ")} = ${total}` : "",
        [],
      );
    }
  }

  // Counts typed per length before update 2 (all kinds together) stay his.
  const legacy: LegacyMoldingLine[] = [];
  for (const lengthFt of MOLDING_LENGTHS) {
    const row = sheetRows.find(
      (r) => moldingLengthForSheet(r.sheetSize) === lengthFt && r.moldingCount != null,
    );
    if (row && typeof row.moldingCount === "number") legacy.push({ lengthFt, count: row.moldingCount });
  }

  return { lines, notCounted, legacy };
}

/** Type (or, with null, clear) his count for one kind and length. */
export function setKindCount(sheetRows: SheetRow[], key: string, count: number | null): SheetRow[] {
  const typed = typedKindCounts(sheetRows);
  if (count === null) typed.delete(key);
  else typed.set(key, count);
  return withKindCounts(sheetRows, typed);
}

function withKindCounts(sheetRows: SheetRow[], typed: Map<string, number>): SheetRow[] {
  const keys = [...typed.keys()].sort();
  return sheetRows.map((row) => {
    if (keys.length === 0) {
      if (!("moldingCounts" in row)) return row;
      const { moldingCounts: _cleared, ...rest } = row;
      return rest;
    }
    const counts: Record<string, number> = {};
    for (const k of keys) counts[k] = typed.get(k)!;
    return sameJson(row.moldingCounts ?? null, counts) ? row : { ...row, moldingCounts: counts };
  });
}

// ---------------------------------------------------------------------------
// Cost lines and the total
// ---------------------------------------------------------------------------

export interface CostInput {
  sheetRows: SheetRow[];
  laborRate: number;
  laborDays: number;
  laborHoursPerDay: number;
  travelMiles: number;
  hotelNights: number;
  freight: number;
  /** Null means "use the automatic profit". */
  profitOverride: number | null;
}

export interface Costs {
  totalSheets: number;
  materials: number;
  labor: number;
  overtimeHours: number;
  overtime: number;
  travel: number;
  hotel: number;
  freight: number;
  autoProfit: number;
  profit: number;
  /** Every line added up. Only a job price when fullyPriced is true. */
  total: number;
  /** Which rule gave the automatic profit. */
  profitRule: "flat" | "per_day";
  /** There are sheets, and every sheet row that has sheets has a price. */
  materialsPriced: boolean;
  /** A labor rate, days and hours a day are all typed. */
  laborPriced: boolean;
  /** Materials and labor are both priced: the total is a real job price. */
  fullyPriced: boolean;
  /** What has no price yet, in words. Empty when fully priced. */
  notPriced: string[];
}

export function computeCosts(input: CostInput): Costs {
  const materials = input.sheetRows.reduce(
    (sum, r) => sum + r.sheetsNeeded * r.pricePerSheet,
    0,
  );
  const sheets = totalSheets(input.sheetRows);
  const rate = input.laborRate;
  const days = input.laborDays;
  const hours = input.laborHoursPerDay;
  const labor = rate * days * hours;
  const overtimeHours = Math.max(0, hours - OVERTIME_AFTER_HOURS) * days;
  const overtime = overtimeHours * OVERTIME_RATE;
  const travel = input.travelMiles * TRAVEL_MULTIPLIER;
  const hotel = input.hotelNights * HOTEL_NIGHTLY;
  const freight = input.freight;
  const autoProfit = flatProfitApplies(sheets)
    ? PROFIT_FLAT
    : PROFIT_PER_DAY * days;
  const profit = input.profitOverride !== null ? input.profitOverride : autoProfit;
  // Same order of addition as the page always used, so totals match to the cent.
  const total = materials + labor + overtime + travel + hotel + freight + profit;

  // Prices are optional ("this part can be unused ... allow us to input those
  // prices manually"). A blank price is stored as 0 and means NOT PRICED: it
  // is never shown as $0.00 and never passed on as part of a job price.
  const unpricedSizes = [
    ...new Set(
      input.sheetRows
        .filter((r) => r.sheetsNeeded > 0 && !(r.pricePerSheet > 0))
        .map((r) => r.sheetSize),
    ),
  ];
  const materialsPriced = sheets > 0 && unpricedSizes.length === 0;
  const laborPriced = rate > 0 && days > 0 && hours > 0;
  const notPriced: string[] = [];
  if (!(sheets > 0)) notPriced.push("sheets (none yet)");
  else if (unpricedSizes.length > 0) notPriced.push(`sheet prices (${unpricedSizes.join(", ")})`);
  if (!laborPriced) notPriced.push("labor");
  return {
    profitRule: flatProfitApplies(sheets) ? "flat" : "per_day",
    materialsPriced,
    laborPriced,
    fullyPriced: materialsPriced && laborPriced,
    notPriced,
    totalSheets: sheets,
    materials,
    labor,
    overtimeHours,
    overtime,
    travel,
    hotel,
    freight,
    autoProfit,
    profit,
    total,
  };
}

/**
 * The total stored with a saved takeoff: the job price to the cent when the
 * takeoff is fully priced, else 0 ("no price"), so a part-total can never be
 * mistaken for a price.
 */
export function savedTotalPrice(input: CostInput): number {
  const costs = computeCosts(input);
  return costs.fullyPriced ? roundToCents(costs.total) : 0;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export function roundToCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}

export type MoneyRead =
  | { ok: true; amount: number }
  | { ok: false; empty: boolean; reason: string };

/**
 * Read a dollar amount typed into a box, strictly.
 *
 * Accepted: digits, an optional leading "$", commas as thousands separators
 * in the right places, and a point with one or two decimals:
 * "4100", "4,100", "$4,100.00", "87.5".
 * Anything else is refused with a reason in words; nothing is guessed. (The
 * old page read "4,100.00" as 4 and printed $4.00 on a proposal.)
 */
export function readTypedAmount(text: string): MoneyRead {
  const typed = text.trim();
  if (typed === "") {
    return { ok: false, empty: true, reason: "No amount is typed." };
  }
  const body = typed.replace(/^\$\s*/, "");
  const withCommas = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/;
  const plain = /^\d+(\.\d{1,2})?$/;
  const centsOnly = /^\.\d{1,2}$/;
  if (withCommas.test(body) || plain.test(body) || centsOnly.test(body)) {
    const amount = Number(body.replace(/,/g, ""));
    if (Number.isFinite(amount)) {
      return { ok: true, amount: roundToCents(amount) };
    }
  }
  return {
    ok: false,
    empty: false,
    reason: `Can't read "${typed}" as a dollar amount. Type it like 4100 or 4,100.00.`,
  };
}

// ---------------------------------------------------------------------------
// Numbers a takeoff may hold
// ---------------------------------------------------------------------------

export type CountRead = { ok: true; count: number } | { ok: false; reason: string };

/**
 * Read a sheet count typed into a box, strictly: digits only, so a whole
 * number of 0 or more. An empty box is 0 (no sheets). "-5", "8.5", "1e3" and
 * words are refused in words; nothing is guessed.
 */
export function readSheetCount(text: string): CountRead {
  const typed = text.trim();
  if (typed === "") return { ok: true, count: 0 };
  if (/^\d+$/.test(typed) && Number.isSafeInteger(Number(typed))) {
    return { ok: true, count: Number(typed) };
  }
  return {
    ok: false,
    reason: `Can't use "${typed}" as a sheet count. Type a whole number of 0 or more, like 12.`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** How a refused value is shown back: 8.5, -5, "abc", nothing. */
function shown(value: unknown): string {
  if (value === undefined) return "missing";
  if (typeof value === "string") return `"${value}"`;
  return typeof value === "number" ? String(value) : (JSON.stringify(value) ?? String(value));
}

/** Nothing typed (null / absent), or a whole number of 0 or more. */
function wholeOrNothing(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A number that is below 0, or not a real number at all (1e999). */
function belowZero(value: unknown): boolean {
  return typeof value === "number" && !(Number.isFinite(value) && value >= 0);
}

const NEVER_BELOW_ZERO: [key: keyof CostInput, name: string][] = [
  ["laborRate", "The labor rate"],
  ["laborDays", "The labor days"],
  ["laborHoursPerDay", "The labor hours a day"],
  ["travelMiles", "The travel miles"],
  ["hotelNights", "The hotel nights"],
  ["freight", "Freight"],
  ["profitOverride", "Profit"],
];

/**
 * Why a takeoff cannot be stored, in plain words. Empty = fine.
 *
 * A sheet count, a corner count and a molding count by kind are whole numbers
 * of 0 or more. No money and no quantity is
 * below 0: sheet prices, molding counts, the labor rate, days, hours, miles,
 * nights, freight, profit. (0 itself is fine: an empty price box is stored as
 * 0 and means "not priced", never a price of $0.00.) Nothing is put right
 * silently.
 *
 * The server runs this on what was sent, before anything is stored. The page
 * runs it on what is on screen and keeps Save off while it has anything to say.
 */
export function checkTakeoffNumbers(takeoff: unknown): string[] {
  const problems: string[] = [];
  const data = isRecord(takeoff) ? takeoff : {};
  const rows = Array.isArray(data.sheetRows) ? data.sheetRows : [];
  rows.forEach((raw: unknown, index: number) => {
    const row = isRecord(raw) ? raw : {};
    const where = `Sheet row ${index + 1}`;
    const count = row.sheetsNeeded;
    if (!(typeof count === "number" && Number.isInteger(count) && count >= 0)) {
      problems.push(
        `${where}: the sheet count must be a whole number of 0 or more (it is ${shown(count)}).`,
      );
    }
    if (belowZero(row.pricePerSheet)) {
      problems.push(`${where}: the price per sheet cannot be below 0 (it is ${shown(row.pricePerSheet)}).`);
    }
    if (belowZero(row.moldingCount)) {
      problems.push(`${where}: the molding count cannot be below 0 (it is ${shown(row.moldingCount)}).`);
    }
    const kinds = row.moldingCounts;
    if (isRecord(kinds)) {
      for (const [key, value] of Object.entries(kinds)) {
        if (!wholeOrNothing(value) || value == null) {
          problems.push(
            `${where}: the ${key.replace("-", " ")} ft molding count must be a whole number of 0 or more (it is ${shown(value)}).`,
          );
        }
      }
    }
  });
  const rooms = Array.isArray(data.roomRows) ? data.roomRows : [];
  rooms.forEach((raw: unknown, index: number) => {
    const row = isRecord(raw) ? raw : {};
    for (const [key, name] of [
      ["insideCorners", "inside corners"],
      ["outsideCorners", "outside corners"],
    ] as const) {
      if (!wholeOrNothing(row[key])) {
        problems.push(
          `Room ${index + 1}: the ${name} must be a whole number of 0 or more (it is ${shown(row[key])}).`,
        );
      }
    }
  });
  for (const [key, name] of NEVER_BELOW_ZERO) {
    if (belowZero(data[key])) {
      problems.push(`${name} cannot be below 0 (it is ${shown(data[key])}).`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Unsaved changes
// ---------------------------------------------------------------------------

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) out[key] = canonical(source[key]);
    }
    return out;
  }
  return value;
}

/**
 * True when two values hold the same data (key order does not matter). The
 * page uses it to tell whether the takeoff on screen is the one that was
 * saved, so a proposal is never made from figures the screen does not show.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * When the answer to a Save comes back: may the screen be replaced by the
 * server's copy? Only when it still shows exactly what it showed when Save
 * was pressed. If the person has typed since (a slow line, a cold start),
 * the screen is left alone: their typing stays, the page remembers what the
 * server stored, and so it reads "Changes not saved" instead of "Saved".
 */
export function screenMayTakeSavedCopy(shownWhenSent: unknown, shownNow: unknown): boolean {
  return sameJson(shownWhenSent, shownNow);
}

const ONES = [
  "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight",
  "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen",
  "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const TENS = [
  "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy",
  "Eighty", "Ninety",
];
const SCALES = ["", " Thousand", " Million", " Billion"];

function threeDigitsToWords(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) parts.push(`${ONES[hundreds]} Hundred`);
  if (rest > 0) {
    if (rest < 20) {
      parts.push(ONES[rest]!);
    } else {
      const ten = TENS[Math.floor(rest / 10)]!;
      const one = rest % 10;
      parts.push(one > 0 ? `${ten}-${ONES[one]}` : ten);
    }
  }
  return parts.join(" ");
}

function integerToWords(n: number): string {
  if (n === 0) return "Zero";
  const groups: string[] = [];
  let remaining = n;
  let scale = 0;
  while (remaining > 0 && scale < SCALES.length) {
    const group = remaining % 1000;
    if (group > 0) {
      groups.unshift(`${threeDigitsToWords(group)}${SCALES[scale]}`);
    }
    remaining = Math.floor(remaining / 1000);
    scale += 1;
  }
  return groups.join(" ");
}

/** e.g. 24680.5 -> "Twenty-Four Thousand Six Hundred Eighty Dollars and Fifty Cents" */
export function amountInWords(amount: number): string {
  const safe = Math.max(0, Math.round(amount * 100));
  const dollars = Math.floor(safe / 100);
  const cents = safe % 100;
  const dollarWords = `${integerToWords(dollars)} Dollar${dollars === 1 ? "" : "s"}`;
  if (cents === 0) return dollarWords;
  return `${dollarWords} and ${integerToWords(cents)} Cent${cents === 1 ? "" : "s"}`;
}
