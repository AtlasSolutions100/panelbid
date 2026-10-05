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
}

/** One sheet line on the takeoff sheet (stored as JSON in takeoffs.sheet_rows). */
export interface SheetRow {
  sheetsNeeded: number;
  sheetSize: SheetSize;
  pricePerSheet: number;
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
export const PROFIT_SHEET_THRESHOLD = 8;

/** True when the job's sheet count gets the flat profit. */
export function flatProfitApplies(totalSheets: number): boolean {
  return totalSheets < PROFIT_SHEET_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Wall lengths
// ---------------------------------------------------------------------------

/** Parse wall lengths typed like "8 + 8 + 8.5, 12" into numbers. */
export function parseWallLengths(input: string): number[] {
  return (input.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}

/** Total wall length in feet for one room. */
export function linearFootage(input: string): number {
  return parseWallLengths(input).reduce((a, b) => a + b, 0);
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
  total: number;
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
  return {
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
