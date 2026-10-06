/**
 * Repair 1 of update 2 (the critic's findings and the desk's ruling).
 * Pure: no database, no network.
 */
import { describe, it, expect } from "vitest";
import {
  CURRENT_RULES,
  WALL_ROUND_UP_TO_FT,
  applySuggestions,
  convertToNewRules,
  jobUnderEarlierRules,
  moldingsByKind,
  refreshSuggestedRows,
  roundWallUp,
  suggestRoom,
  suggestSheets,
  wallRoundingWords,
  type RoomRow,
  type SheetRow,
} from "./takeoffRules";
import { sheetAllotment } from "./proposalRules";
import { buildMaterialList } from "./materialList";

const room = (over: Partial<RoomRow> = {}): RoomRow => ({
  roomName: "Kitchen",
  roomNumber: "101",
  wallLengths: "",
  materialHeight: null,
  manufacturer: null,
  color: null,
  productCode: null,
  fireRating: null,
  moldingType: null,
  ceilingHeight: null,
  ...over,
});

// ---------------------------------------------------------------------------
// BLOCKER-1: an old job that he edits must not count a room twice
// ---------------------------------------------------------------------------
describe("an old job that he edits never counts a room twice (BLOCKER-1)", () => {
  // Saved by 07066ab: Kitchen 20 ft at 8 ft + Hall 8 + 8 at 4 ft (Symetrix): one row, 9 x 4x8.
  const hallRooms: RoomRow[] = [
    room({ roomName: "Kitchen", wallLengths: "20", materialHeight: "8'" }),
    room({ roomName: "Hall", roomNumber: "105", wallLengths: "8 + 8", materialHeight: "4'", manufacturer: "Marlite", productCode: "Symetrix" }),
  ];
  const hallRows: SheetRow[] = [{ sheetsNeeded: 9, sheetSize: "4x8", pricePerSheet: 0, sheetsSource: "suggested" }];
  const hallEdited = hallRooms.map((r, i) => (i === 1 ? { ...r, wallLengths: "8 + 8 + 4" } : r));

  it("the Symetrix hall: a wall edit adds no new row; the job stays at its saved 9 sheets", () => {
    expect(jobUnderEarlierRules(hallRows)).toBe(true);
    const after = applySuggestions(hallRooms, hallEdited, hallRows);
    expect(after).toEqual(hallRows);
    expect(sheetAllotment(after)).toMatchObject({ total: 9, phrase: "9 4x8" });
  });

  it("the Symetrix hall: 'use the new counts' converts every size at once and says what changes", () => {
    const c = convertToNewRules(hallEdited, hallRows);
    expect(c.changes).toEqual([
      { size: "4x4", before: 0, after: 5 },
      { size: "4x8", before: 9, after: 5 },
    ]);
    expect(c.rows.map((r) => `${r.sheetsNeeded} ${r.sheetSize} ${r.sheetsSource} ${r.rules}`)).toEqual([
      `5 4x4 suggested ${CURRENT_RULES}`,
      `5 4x8 suggested ${CURRENT_RULES}`,
    ]);
    expect(jobUnderEarlierRules(c.rows)).toBe(false);
    expect(sheetAllotment(c.rows).total).toBe(10);
  });

  // Saved by 07066ab: Prep 20 ft at 10 ft (5 x 4x10) + Cooler 24 ft at 14 ft (6 x 4x12, one per 4 ft).
  const coolerRooms: RoomRow[] = [
    room({ roomName: "Prep", roomNumber: "102", wallLengths: "20", materialHeight: "10'" }),
    room({ roomName: "Cooler", roomNumber: "104", wallLengths: "24", materialHeight: "14'" }),
  ];
  const coolerRows: SheetRow[] = [
    { sheetsNeeded: 5, sheetSize: "4x10", pricePerSheet: 0, sheetsSource: "suggested" },
    { sheetsNeeded: 6, sheetSize: "4x12", pricePerSheet: 0, sheetsSource: "suggested" },
  ];
  const coolerEdited = coolerRooms.map((r, i) => (i === 1 ? { ...r, wallLengths: "24 + 2" } : r));

  it("the 14 ft cooler: a wall edit adds no 4x8 row and moves no row", () => {
    const after = applySuggestions(coolerRooms, coolerEdited, coolerRows);
    expect(after).toEqual(coolerRows);
    expect(sheetAllotment(after).phrase).toBe("5 4x10 and 6 4x12");
  });

  it("the 14 ft cooler: 'use the new counts' replaces the 4x12 row with the stack", () => {
    // Cooler 26 ft: 10 upright (6.5 x 4x10) + 4 ft on its side (3.25 x 4x8); Prep 5 x 4x10.
    const c = convertToNewRules(coolerEdited, coolerRows);
    expect(c.changes).toEqual([
      { size: "4x8", before: 0, after: 4 },
      { size: "4x10", before: 5, after: 12 },
      { size: "4x12", before: 6, after: 0 },
    ]);
    expect(sheetAllotment(c.rows).phrase).toBe("4 4x8 and 12 4x10");
  });

  it("rows he typed stay his through the conversion", () => {
    const rows: SheetRow[] = [...hallRows, { sheetsNeeded: 3, sheetSize: "4x10", pricePerSheet: 50, sheetsSource: "typed" }];
    const c = convertToNewRules(hallEdited, rows);
    expect(c.rows).toContainEqual({ sheetsNeeded: 3, sheetSize: "4x10", pricePerSheet: 50, sheetsSource: "typed" });
  });

  it("a job with no earlier rows has nothing to convert", () => {
    const rows = applySuggestions([], hallRooms, []);
    expect(jobUnderEarlierRules(rows)).toBe(false);
    expect(convertToNewRules(hallRooms, rows).changes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MAJOR-1: the rules mark moves with the rounding change
// ---------------------------------------------------------------------------
describe("rows suggested under 655754f's rules (rules 2) are earlier rules now", () => {
  it("CURRENT_RULES is 3, and a rules-2 row keeps its saved count", () => {
    expect(CURRENT_RULES).toBe(3);
    const rooms = [room({ wallLengths: "10 + 10 + 10 + 10", materialHeight: "8'" })];
    const rows: SheetRow[] = [{ sheetsNeeded: 12, sheetSize: "4x8", pricePerSheet: 0, sheetsSource: "suggested", rules: 2 }];
    expect(refreshSuggestedRows(rooms, rows)).toEqual(rows);
    expect(jobUnderEarlierRules(rows)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The desk's ruling: up to the next even foot, still ASSUMED
// ---------------------------------------------------------------------------
describe("the desk's ruling: walls up to the next even foot (assumed)", () => {
  it("the constant is 2: a 5 ft wall counts as 6 ft; his examples still hold", () => {
    expect(WALL_ROUND_UP_TO_FT).toBe(2);
    expect(roundWallUp(5)).toBe(6);
    expect(roundWallUp(7)).toBe(8);
    expect(roundWallUp(3)).toBe(4);
  });

  it("the screen words say ASSUMED for either reading", () => {
    expect(wallRoundingWords()).toMatch(/next even foot.*ASSUMED/);
    expect(wallRoundingWords(2)).toMatch(/ASSUMED/);
    expect(wallRoundingWords(4)).toMatch(/next 4 ft.*ASSUMED/);
  });

  it("a room whose count differs under the other reading says so", () => {
    const s = suggestRoom(room({ wallLengths: "5", materialHeight: "8'" }));
    expect(s.countedFeet).toBe(6);
    expect(s.otherReading).toEqual({ roundingFt: 4, countedFeet: 8, sheets: 2 });
    expect(s.readingNote).toBe("assumed: each wall up to the next even foot; up to the next 4 ft this room would be 8 ft, 2 sheets");
    expect(suggestRoom(room({ wallLengths: "8 + 8", materialHeight: "8'" })).otherReading).toBeNull();
  });

  it("half sheets are added per size and rounded once, at the end of the job", () => {
    const job = suggestSheets([
      room({ roomName: "Bar", wallLengths: "10", materialHeight: "4'" }),
      room({ roomName: "Hall", wallLengths: "10", materialHeight: "4'" }),
    ]);
    expect(job.rooms.map((r) => r.sheets)).toEqual([1.25, 1.25]);
    expect(job.bySize["4x8"]).toBe(3);
    expect(job.sizeWorking["4x8"]).toBe("4x8: 1.25 + 1.25 = 2.5, rounded up to 3 sheets");
  });
});

// ---------------------------------------------------------------------------
// MINOR-2 and MINOR-3: the stack's words
// ---------------------------------------------------------------------------
describe("the stack says what the job has and what is cut", () => {
  it("a job with 8s and 10s names both and says it chose the 10", () => {
    const job = suggestSheets([
      room({ roomName: "Kitchen", wallLengths: "32", materialHeight: "8'" }),
      room({ roomName: "Prep", wallLengths: "40", materialHeight: "10'" }),
      room({ roomName: "Cooler", wallLengths: "16", materialHeight: "14'" }),
    ]);
    const note = job.rooms[2]!.stack!.note;
    expect(note).not.toMatch(/the rest of the job uses 10 ft sheets/);
    expect(note).toMatch(/8 ft and 10 ft sheets/);
    expect(note).toMatch(/starts with a 10 ft sheet/);
    expect(note).toMatch(/your call/);
  });

  it("a 16 ft wall stacked 10 + 10 says the top course is cut, and by how much", () => {
    const job = suggestSheets([
      room({ roomName: "Prep", wallLengths: "40", materialHeight: "10'" }),
      room({ roomName: "Cooler", wallLengths: "16", materialHeight: "16'" }),
    ]);
    const stack = job.rooms[1]!.stack!;
    expect(stack.courses).toEqual([10, 10]);
    expect(stack.text).toMatch(/top course cut by 4 ft/);
    // his own example reaches 14 ft exactly: nothing is cut
    const his = suggestSheets([
      room({ roomName: "Prep", wallLengths: "40", materialHeight: "10'" }),
      room({ roomName: "Cooler", wallLengths: "16", materialHeight: "14'" }),
    ]);
    expect(his.rooms[1]!.stack!.text).not.toMatch(/cut by/);
  });
});

// ---------------------------------------------------------------------------
// MINOR-4: an old job's moldings are not worked out from the new rules
// ---------------------------------------------------------------------------
describe("an old job's Material list does not mix the two rule sets", () => {
  const rooms: RoomRow[] = [
    room({ roomName: "Kitchen", wallLengths: "20", materialHeight: "8'" }),
    room({ roomName: "Hall", roomNumber: "105", wallLengths: "8 + 8", materialHeight: "4'", productCode: "Symetrix" }),
  ];
  const rows: SheetRow[] = [{ sheetsNeeded: 9, sheetSize: "4x8", pricePerSheet: 0, sheetsSource: "suggested" }];

  it("caps and dividers are not worked out until he uses the new counts, and it says so", () => {
    const m = moldingsByKind(rooms, rows);
    expect(m.lines.filter((l) => l.kind === "cap" || l.kind === "divider")).toEqual([]);
    expect(m.notCounted.join(" ")).toMatch(/earlier rules/);
    const list = buildMaterialList({ jobName: "Old", address: "", city: "", date: "", thickness: null, roomRows: rooms, sheetRows: rows });
    expect(list.moldings).toEqual([]);
    expect(list.notCounted.join(" ")).toMatch(/earlier rules/);
    expect(list.sheets[0]).toMatchObject({ size: "4x8", count: 9, whose: "earlier" });
  });

  it("after 'use the new counts' they are worked out again", () => {
    const c = convertToNewRules(rooms, rows);
    expect(moldingsByKind(rooms, c.rows).lines.some((l) => l.kind === "cap")).toBe(true);
  });
});
