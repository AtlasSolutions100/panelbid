/**
 * Repair 2 of update 2 (critic round 2, BLOCKER-2): a job where he typed his
 * own counts. A typed row is his decision about the job, and the app cannot
 * tell which rooms it covers, so the app never adds a row of a size by itself
 * while the job holds a typed row: it says what the walls need and offers
 * "add N x size". Pure: no database, no network.
 */
import { describe, it, expect } from "vitest";
import {
  CURRENT_RULES,
  addSuggestedSize,
  applySuggestions,
  convertToNewRules,
  jobHasTypedRow,
  refreshSuggestedRows,
  wallNeeds,
  type RoomRow,
  type SheetRow,
} from "./takeoffRules";
import { sheetAllotment } from "./proposalRules";

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

describe("the typed Symetrix hall", () => {
  // Kitchen 20 ft @ 8 + Hall 8 + 8 @ 4 ft (Symetrix); he typed 7 x 4x8 (the hall halved).
  const rooms: RoomRow[] = [
    room({ roomName: "Kitchen", wallLengths: "20", materialHeight: "8'" }),
    room({ roomName: "Hall", roomNumber: "105", wallLengths: "8 + 8", materialHeight: "4'", manufacturer: "Marlite", productCode: "Symetrix" }),
  ];
  const rows: SheetRow[] = [{ sheetsNeeded: 7, sheetSize: "4x8", pricePerSheet: 0, sheetsSource: "typed" }];
  const edited = rooms.map((r, i) => (i === 1 ? { ...r, wallLengths: "8 + 8 + 4" } : r));

  it("a room edit adds no 4x4 row beside his typed 4x8; the proposal still prints 7 4x8", () => {
    expect(jobHasTypedRow(rows)).toBe(true);
    const after = applySuggestions(rooms, edited, rows);
    expect(after).toEqual(rows);
    expect(sheetAllotment(after).phrase).toBe("7 4x8");
    expect(refreshSuggestedRows(edited, after)).toEqual(rows);
  });

  it("it says what the walls need, size by size, and offers to add the missing size", () => {
    expect(wallNeeds(edited, rows)).toEqual([
      { size: "4x4", need: 5, have: 0, typed: 0, canAdd: true },
      { size: "4x8", need: 5, have: 7, typed: 7, canAdd: false },
    ]);
    const added = addSuggestedSize(edited, rows, "4x4");
    expect(added).toEqual([
      { sheetsNeeded: 5, sheetSize: "4x4", pricePerSheet: 0, sheetsSource: "suggested", rules: CURRENT_RULES },
      rows[0],
    ]);
    expect(sheetAllotment(added).phrase).toBe("5 4x4 and 7 4x8");
  });
});

describe("the typed 14 ft cooler", () => {
  // Prep 20 ft @ 10 + Cooler 24 ft @ 14; he typed 5 x 4x10 and 12 x 4x12.
  const rooms: RoomRow[] = [
    room({ roomName: "Prep", roomNumber: "102", wallLengths: "20", materialHeight: "10'" }),
    room({ roomName: "Cooler", roomNumber: "104", wallLengths: "24", materialHeight: "14'" }),
  ];
  const rows: SheetRow[] = [
    { sheetsNeeded: 5, sheetSize: "4x10", pricePerSheet: 0, sheetsSource: "typed" },
    { sheetsNeeded: 12, sheetSize: "4x12", pricePerSheet: 0, sheetsSource: "typed" },
  ];
  const edited = rooms.map((r, i) => (i === 1 ? { ...r, wallLengths: "24 + 2" } : r));

  it("a room edit adds no 4x8 row for the top course; the proposal prints his 5 4x10 and 12 4x12", () => {
    const after = applySuggestions(rooms, edited, rows);
    expect(after).toEqual(rows);
    expect(sheetAllotment(after).phrase).toBe("5 4x10 and 12 4x12");
  });

  it("the need for 4x8 is shown, not added", () => {
    const needs = wallNeeds(edited, rows);
    expect(needs.find((n) => n.size === "4x8")).toEqual({ size: "4x8", need: 4, have: 0, typed: 0, canAdd: true });
    expect(needs.find((n) => n.size === "4x12")).toEqual({ size: "4x12", need: 0, have: 12, typed: 12, canAdd: false });
  });
});

describe("his typed 4x12 beside a 4x10 suggested under the earlier rules", () => {
  const rooms: RoomRow[] = [
    room({ roomName: "Prep", roomNumber: "102", wallLengths: "20", materialHeight: "10'" }),
    room({ roomName: "Cooler", roomNumber: "104", wallLengths: "24 + 2", materialHeight: "14'" }),
  ];
  const rows: SheetRow[] = [
    { sheetsNeeded: 5, sheetSize: "4x10", pricePerSheet: 0, sheetsSource: "suggested" },
    { sheetsNeeded: 12, sheetSize: "4x12", pricePerSheet: 0, sheetsSource: "typed" },
  ];

  it("'Use the new counts' names his typed row before he presses it, and never changes it", () => {
    const c = convertToNewRules(rooms, rows);
    expect(c.typedKept).toEqual([
      "Your 12 x 4x12 stays as you typed it. The new rows may count the same walls: remove or change it yourself if they do.",
    ]);
    expect(c.rows).toContainEqual(rows[1]);
  });

  it("an edit before converting moves nothing", () => {
    const edited = rooms.map((r, i) => (i === 0 ? { ...r, wallLengths: "24" } : r));
    expect(applySuggestions(rooms, edited, rows)).toEqual(rows);
    expect(sheetAllotment(rows).phrase).toBe("5 4x10 and 12 4x12");
  });
});

describe("a job with no typed row still follows the walls", () => {
  it("suggested rows update and new sizes are added as before", () => {
    const rooms = [room({ wallLengths: "20", materialHeight: "8'" })];
    const rows = applySuggestions([], rooms, []);
    expect(jobHasTypedRow(rows)).toBe(false);
    const more = [...rooms, room({ roomName: "Hall", wallLengths: "16", materialHeight: "4'", productCode: "Symetrix" })];
    expect(applySuggestions(rooms, more, rows).map((r) => `${r.sheetsNeeded} ${r.sheetSize}`)).toEqual(["4 4x4", "5 4x8"]);
  });

  it("an empty typed row (0 sheets, as Add Sheet Row makes it) does not stop the walls being followed", () => {
    const rooms = [room({ wallLengths: "20", materialHeight: "8'" })];
    const rows: SheetRow[] = [...applySuggestions([], rooms, []), { sheetsNeeded: 0, sheetSize: "4x8", pricePerSheet: 0, sheetsSource: "typed" }];
    expect(jobHasTypedRow(rows)).toBe(false);
  });
});
