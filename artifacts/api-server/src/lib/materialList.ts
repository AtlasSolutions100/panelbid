/**
 * The Material list: the typed sheet the client asked for on his call
 * ("it's this many 4x10s, this amount of molding, glue"), worked out from the
 * takeoff with the same rules as everything else. Pure: no database, no
 * browser. Tested in materialList.test.ts.
 */
import {
  GLUE_SHEETS_PER_BUCKET,
  SHEET_SIZES,
  feetText,
  glueBuckets,
  isSuggested,
  moldingLines,
  roomLabel,
  suggestSheets,
  type MoldingLine,
  type RoomRow,
  type SheetRow,
  type SheetSize,
} from "./takeoffRules";

export interface MaterialListInput {
  jobName: string;
  address: string;
  city: string;
  /** The date to print, as text. */
  date: string;
  thickness: string | null;
  roomRows: RoomRow[];
  sheetRows: SheetRow[];
}

export interface MaterialSheetLine {
  size: SheetSize;
  count: number;
  /** Whose count it is. */
  whose: "suggested" | "yours" | "both";
  /** What the wall lengths suggest for this size. */
  suggested: number;
  /** Price per sheet when he typed one price for this size, else null. */
  price: number | null;
  /** Count x price when every row of this size is priced, else null. */
  total: number | null;
}

export interface MaterialRoomLine {
  label: string;
  /** Wall lengths exactly as typed. */
  wallText: string;
  wallFeet: number;
  /** "8 ft", "10 ft (assumed to ceiling)", or what is missing. */
  heightText: string;
  sheets: number | null;
  sheetSize: SheetSize | null;
  /** The working, in words. Empty when there is no suggestion. */
  arithmetic: string;
  /** Why the room has no suggested count. Null when it has one. */
  problem: string | null;
}

export interface MaterialList {
  jobName: string;
  address: string;
  city: string;
  date: string;
  thickness: string | null;
  sheets: MaterialSheetLine[];
  totalSheets: number;
  moldings: MoldingLine[];
  glue: { buckets: number; arithmetic: string };
  rooms: MaterialRoomLine[];
  /** Every assumption behind the numbers, in plain words. */
  assumptions: string[];
  /** Rooms that are not in the suggested count, and why. */
  notCounted: string[];
  /** True only when he typed at least one sheet price. */
  showPrices: boolean;
  /** Sum of the sheet lines when every sheet is priced, else null. */
  materialsTotal: number | null;
}

function said(row: RoomRow): boolean {
  return [row.roomName, row.roomNumber, row.wallLengths, row.materialHeight, row.ceilingHeight].some(
    (v) => (v ?? "").trim() !== "",
  );
}

export function buildMaterialList(input: MaterialListInput): MaterialList {
  const roomRows = input.roomRows.filter(said);
  const suggestion = suggestSheets(roomRows);

  // --- sheets by size
  const sheets: MaterialSheetLine[] = [];
  for (const size of SHEET_SIZES) {
    const mine = input.sheetRows.filter((r) => r.sheetSize === size && r.sheetsNeeded > 0);
    if (mine.length === 0) continue;
    const count = mine.reduce((sum, r) => sum + r.sheetsNeeded, 0);
    const anySuggested = mine.some(isSuggested);
    const anyTyped = mine.some((r) => !isSuggested(r));
    const prices = [...new Set(mine.map((r) => r.pricePerSheet))];
    const allPriced = mine.every((r) => r.pricePerSheet > 0);
    sheets.push({
      size,
      count,
      whose: anySuggested && anyTyped ? "both" : anySuggested ? "suggested" : "yours",
      suggested: suggestion.bySize[size],
      price: allPriced && prices.length === 1 ? prices[0]! : null,
      total: allPriced ? mine.reduce((sum, r) => sum + r.sheetsNeeded * r.pricePerSheet, 0) : null,
    });
  }
  const totalSheets = sheets.reduce((sum, s) => sum + s.count, 0);
  const showPrices = input.sheetRows.some((r) => r.sheetsNeeded > 0 && r.pricePerSheet > 0);
  const materialsTotal =
    sheets.length > 0 && sheets.every((s) => s.total !== null)
      ? sheets.reduce((sum, s) => sum + (s.total ?? 0), 0)
      : null;

  // --- moldings and glue
  const moldings = moldingLines(input.sheetRows).filter((m) => m.count > 0 || m.typed);
  const glue = glueBuckets(totalSheets);

  // --- rooms
  const rooms: MaterialRoomLine[] = roomRows.map((row, index) => {
    const s = suggestion.rooms[index]!;
    const heightText =
      s.height.feet === null
        ? s.height.note
        : s.height.assumed
          ? `${feetText(s.height.feet)} (assumed to ceiling)`
          : feetText(s.height.feet);
    return {
      label: roomLabel(row, index),
      wallText: row.wallLengths.trim(),
      wallFeet: s.wall.feet,
      heightText,
      sheets: s.sheets,
      sheetSize: s.sheetSize,
      arithmetic: s.arithmetic,
      problem: s.problem,
    };
  });

  // --- assumptions, in plain words
  const assumptions: string[] = [
    "Walls are measured straight through doors and windows. That is the waste: no extra waste is added and no opening is taken out.",
    "Sheets for a room = its wall length ÷ the 4 ft sheet width, rounded up. Each room is rounded up on its own.",
    "Sheet length: 4x8 for panels 8 ft high or less, 4x10 above 8 ft up to 10 ft, 4x12 above 10 ft.",
  ];
  roomRows.forEach((row, index) => {
    const h = suggestion.rooms[index]!.height;
    if (h.assumed && h.feet !== null) {
      assumptions.push(
        `${roomLabel(row, index)}: no panel height given, so floor to ceiling is assumed (${feetText(h.feet)}).`,
      );
    }
  });
  roomRows.forEach((row, index) => {
    const warning = suggestion.rooms[index]!.warning;
    if (warning) assumptions.push(`${roomLabel(row, index)}: ${warning}. Add the sheets above 12 ft yourself.`);
  });
  for (const s of sheets) {
    if (s.whose === "suggested") continue;
    assumptions.push(
      s.suggested > 0 && s.suggested !== s.count
        ? `${s.size}: ${s.count} sheets is your own count (the wall lengths suggest ${s.suggested}).`
        : `${s.size}: ${s.count} sheets is your own count.`,
    );
  }
  if (moldings.length > 0) {
    assumptions.push(
      "Molding length: 8 ft moldings for sheets 8 ft high or less, 10 ft moldings for sheets above 8 ft.",
    );
  }
  for (const m of moldings) {
    assumptions.push(
      m.typed
        ? `${m.lengthFt} ft molding: ${m.count} is your own count.`
        : `${m.lengthFt} ft molding: the count is ASSUMED at one per sheet. That is not a confirmed rule: tell us how you count moldings.`,
    );
  }
  if (totalSheets > 0) {
    assumptions.push(
      `Glue: one bucket does ${GLUE_SHEETS_PER_BUCKET} sheets of any height, rounded up to whole buckets.`,
    );
  }

  const notCounted = rooms
    .filter((r) => r.problem !== null)
    .map((r) => `${r.label}: not in the suggested count (${r.problem}).`);

  return {
    jobName: input.jobName,
    address: input.address,
    city: input.city,
    date: input.date,
    thickness: (input.thickness ?? "").trim() || null,
    sheets,
    totalSheets,
    moldings,
    glue,
    rooms,
    assumptions,
    notCounted,
    showPrices,
    materialsTotal,
  };
}

// ---------------------------------------------------------------------------
// The printed page (opened in a new window and printed, like the proposal)
// ---------------------------------------------------------------------------

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function dollars(n: number): string {
  const [whole, cents] = n.toFixed(2).split(".");
  return "$" + whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + cents;
}

const WHOSE: Record<MaterialSheetLine["whose"], string> = {
  suggested: "suggested from the wall lengths",
  yours: "your own count",
  both: "part suggested, part your own",
};

/** Standalone HTML for the Material list. Prices appear only if he typed any. */
export function materialListHtml(list: MaterialList): string {
  const money = list.showPrices;
  const sheetRows = list.sheets
    .map(
      (s) =>
        `<tr><td>${s.size}</td><td class="n">${s.count}</td><td>${WHOSE[s.whose]}</td>` +
        (money
          ? `<td class="n">${s.price !== null ? dollars(s.price) : s.total !== null ? "mixed" : "not priced"}</td>` +
            `<td class="n">${s.total !== null ? dollars(s.total) : "not priced"}</td>`
          : "") +
        `</tr>`,
    )
    .join("");
  const sheetTotal =
    `<tr class="t"><td>All sheets</td><td class="n">${list.totalSheets}</td><td></td>` +
    (money
      ? `<td></td><td class="n">${list.materialsTotal !== null ? dollars(list.materialsTotal) : "not priced"}</td>`
      : "") +
    `</tr>`;
  const moldingRows = list.moldings
    .map(
      (m) =>
        `<tr><td>${m.lengthFt} ft molding</td><td class="n">${m.count}</td><td>${
          m.typed ? "your own count" : "ASSUMED one per sheet (not a confirmed rule)"
        }</td></tr>`,
    )
    .join("");
  const roomRows = list.rooms
    .map(
      (r) =>
        `<tr><td>${esc(r.label)}</td><td>${esc(r.wallText) || "&mdash;"}</td>` +
        `<td class="n">${r.wallFeet > 0 ? `${Number(r.wallFeet.toFixed(2))} ft` : "&mdash;"}</td>` +
        `<td>${esc(r.heightText)}</td>` +
        `<td>${r.sheets !== null ? `${r.sheets} &times; ${r.sheetSize}` : "&mdash;"}</td>` +
        `<td class="w">${esc(r.sheets !== null ? r.arithmetic : (r.problem ?? ""))}</td></tr>`,
    )
    .join("");
  const place = [list.address, list.city].map((v) => v.trim()).filter(Boolean).join(", ");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Material List - ${esc(list.jobName)}</title>
<style>
  @page { size: letter; margin: 0.6in; }
  body { font-family: Arial, Helvetica, sans-serif; color: #000; font-size: 10.5pt; line-height: 1.35; margin: 0; }
  .company { font-size: 13pt; font-weight: bold; letter-spacing: 0.5px; }
  h1 { font-size: 15pt; margin: 2px 0 6px; }
  h2 { font-size: 11pt; margin: 16px 0 4px; border-bottom: 1px solid #000; padding-bottom: 2px; }
  .meta { margin: 1px 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #999; padding: 3px 6px; text-align: left; vertical-align: top; }
  th { background: #eee; font-size: 9.5pt; }
  td.n { text-align: right; white-space: nowrap; }
  td.w { font-size: 9pt; color: #333; }
  tr.t td { font-weight: bold; }
  ul { margin: 4px 0 0 18px; padding: 0; }
  li { margin: 2px 0; }
  .small { font-size: 9pt; color: #333; }
</style></head>
<body>
  <div class="company">RIVER CITY PLASTICS, INC.</div>
  <h1>MATERIAL LIST</h1>
  <p class="meta"><b>Job:</b> ${esc(list.jobName)}${place ? ` &mdash; ${esc(place)}` : ""}</p>
  <p class="meta"><b>Date:</b> ${esc(list.date)}${list.thickness ? ` &nbsp; <b>Panel thickness:</b> ${esc(list.thickness)}` : ""}</p>

  <h2>Sheets</h2>
  ${
    list.sheets.length > 0
      ? `<table><tr><th>Size</th><th>Sheets</th><th>Count from</th>${money ? "<th>Each</th><th>Total</th>" : ""}</tr>${sheetRows}${sheetTotal}</table>`
      : `<p>No sheets yet.</p>`
  }

  <h2>Moldings</h2>
  ${
    list.moldings.length > 0
      ? `<table><tr><th>Length</th><th>Pieces</th><th>Count from</th></tr>${moldingRows}</table>`
      : `<p>No moldings yet.</p>`
  }

  <h2>Glue</h2>
  <p><b>${list.glue.buckets} bucket${list.glue.buckets === 1 ? "" : "s"}</b> <span class="small">(${esc(list.glue.arithmetic)})</span></p>

  <h2>Rooms</h2>
  ${
    list.rooms.length > 0
      ? `<table><tr><th>Room</th><th>Wall lengths as typed</th><th>Wall</th><th>Panel height</th><th>Suggested</th><th>Working</th></tr>${roomRows}</table>`
      : `<p>No rooms yet.</p>`
  }
  ${
    list.notCounted.length > 0
      ? `<h2>Not counted</h2><ul>${list.notCounted.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`
      : ""
  }

  <h2>Assumptions used</h2>
  <ul>${list.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>
</body></html>`;
}
