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
  /** Typed molding count for this row's molding length; null/absent = not typed. */
  moldingCount?: number | null;
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
const PLAIN_NUMBER = /^\d+(?:\.\d+)?$/;
const PLAIN_NUMBERS = /^\d+(?:\.\d+)?(?:\s+\d+(?:\.\d+)?)+$/;

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

export interface RoomSuggestion {
  wall: LengthRead;
  height: PanelHeight;
  /** Null when no count can be suggested (see problem). */
  sheets: number | null;
  /** Null when the room has no height. */
  sheetSize: SheetSize | null;
  /** The working, in words, e.g. "34 ft of wall ÷ 4 ft a sheet = 8.5, rounded up to 9 sheets of 4x10". */
  arithmetic: string;
  /** Why there is no suggestion, in words. Null when there is one. */
  problem: string | null;
}

/**
 * Suggested sheets for one room: wall length ÷ the 4 ft sheet width, rounded
 * up. The walls are measured straight through doors and windows ("Yes we
 * measure through windows and doors to get our waste"), so NO waste is added
 * and NO opening is taken out.
 */
export function suggestRoom(row: RoomRow): RoomSuggestion {
  const wall = readWallLengths(row.wallLengths);
  const height = resolvePanelHeight(row);
  const sheetSize = height.feet !== null ? sheetSizeForHeight(height.feet) : null;
  let problem: string | null = null;
  if (!wall.ok) problem = `can't read "${wall.unread[0]}" in the wall lengths`;
  else if (wall.units <= 0) problem = "no wall length typed";
  else if (sheetSize === null) problem = height.note;
  if (problem !== null || sheetSize === null) {
    return { wall, height, sheets: null, sheetSize, arithmetic: "", problem };
  }
  const sheetUnits = SHEET_WIDTH_FT * UNITS_PER_FOOT;
  const sheets = Math.ceil(wall.units / sheetUnits);
  const noun = sheets === 1 ? "sheet" : "sheets";
  const start = `${plain(wall.feet)} ft of wall ÷ ${SHEET_WIDTH_FT} ft a sheet = `;
  const arithmetic =
    wall.units % sheetUnits === 0
      ? `${start}${sheets} ${noun} of ${sheetSize}`
      : `${start}${plain(wall.feet / SHEET_WIDTH_FT)}, rounded up to ${sheets} ${noun} of ${sheetSize}`;
  return { wall, height, sheets, sheetSize, arithmetic, problem: null };
}

export interface JobSuggestion {
  rooms: RoomSuggestion[];
  /** Suggested sheets per size (each room rounded up on its own, then added). */
  bySize: Record<SheetSize, number>;
}

export function suggestSheets(roomRows: RoomRow[]): JobSuggestion {
  const rooms = roomRows.map(suggestRoom);
  const bySize: Record<SheetSize, number> = { "4x4": 0, "4x8": 0, "4x10": 0, "4x12": 0 };
  for (const r of rooms) {
    if (r.sheets !== null && r.sheetSize !== null) bySize[r.sheetSize] += r.sheets;
  }
  return { rooms, bySize };
}

export function isSuggested(row: SheetRow): boolean {
  return row.sheetsSource === "suggested";
}

/**
 * Bring every SUGGESTED sheet row up to date with the rooms. Rows the person
 * typed are returned untouched. No row is added or removed. The server runs
 * this on every save and before every proposal, so a stale suggested count is
 * never stored or printed.
 */
export function refreshSuggestedRows(roomRows: RoomRow[], sheetRows: SheetRow[]): SheetRow[] {
  const bySize = suggestSheets(roomRows).bySize;
  const given = new Set<SheetSize>();
  return sheetRows.map((row) => {
    if (!isSuggested(row)) return row;
    const count = given.has(row.sheetSize) ? 0 : bySize[row.sheetSize];
    given.add(row.sheetSize);
    return row.sheetsNeeded === count ? row : { ...row, sheetsNeeded: count };
  });
}

/**
 * The sheet rows after the rooms changed from prevRooms to nextRooms.
 *
 * - Suggested rows follow the wall lengths.
 * - A size whose suggestion changed and that has no row at all gets a
 *   suggested row.
 * - A row the person typed is never changed, and no suggested row is added
 *   beside it for the same size.
 * - A suggested row the person deleted does not come back until the
 *   suggestion for that size itself changes.
 * - A suggested row with nothing typed in it goes away when its rooms do.
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
      rows.push({
        sheetsNeeded: after[size],
        sheetSize: size,
        pricePerSheet: 0,
        sheetsSource: "suggested",
      });
    }
  }
  return refreshSuggestedRows(nextRooms, rows).filter(
    (r) =>
      !(isSuggested(r) && r.sheetsNeeded === 0 && !(r.pricePerSheet > 0) && r.moldingCount == null),
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

/** Type (or, with null, clear) the molding count for one length. */
export function setMoldingCount(
  sheetRows: SheetRow[],
  lengthFt: MoldingLength,
  count: number | null,
): SheetRow[] {
  return sheetRows.map((r) =>
    moldingLengthForSheet(r.sheetSize) === lengthFt ? { ...r, moldingCount: count } : r,
  );
}

/** Make every sheet row of a length carry that length's typed count. */
export function tidyMoldingCounts(sheetRows: SheetRow[]): SheetRow[] {
  const typed = new Map<MoldingLength, number | null>();
  for (const line of moldingLines(sheetRows)) {
    typed.set(line.lengthFt, line.typed ? line.count : null);
  }
  return sheetRows.map((r) => {
    const want = typed.get(moldingLengthForSheet(r.sheetSize)) ?? null;
    return (r.moldingCount ?? null) === want ? r : { ...r, moldingCount: want };
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
