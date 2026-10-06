/**
 * Repair 4 of update 2 (critic round 4). Pure: no database, no network.
 * - Rooms with no wall length or no usable height are left out of the
 *   proposal's count check, and the words say so; a job where no room can be
 *   counted is not checked at all. "The walls need 0" is never said for walls
 *   that were not measured.
 * - The check carries a fingerprint of what he saw, so a confirmation only
 *   covers those rows.
 */
import { describe, it, expect } from "vitest";
import { applySuggestions, countCheck, type RoomRow, type SheetRow } from "./takeoffRules";

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

describe("rooms that cannot be counted are not checked (MAJOR-R4-1)", () => {
  it("a job with no wall lengths and typed counts is not checked, and does not stop", () => {
    const rooms = [room({ materialHeight: "8'" })];
    const rows: SheetRow[] = [{ sheetsNeeded: 12, sheetSize: "4x8", pricePerSheet: 0, sheetsSource: "typed" }];
    const c = countCheck(rooms, rows);
    expect(c.checked).toBe(false);
    expect(c.differences).toEqual([]);
    expect(c.note).toBe("No room has both a wall length and a height, so the sheet counts are not checked against the walls.");
  });

  it("a room with no height beside counted rooms is left out; no 'need 0' for its sheets", () => {
    const rooms = [
      room({ wallLengths: "20", materialHeight: "8'" }),
      room({ roomName: "Prep", roomNumber: "102", wallLengths: "30" }),
    ];
    const rows: SheetRow[] = [
      ...applySuggestions([], rooms, []),
      { sheetsNeeded: 8, sheetSize: "4x10", pricePerSheet: 0, sheetsSource: "typed" },
    ];
    const c = countCheck(rooms, rows);
    expect(c.checked).toBe(true);
    expect(c.uncountedRooms).toBe(1);
    expect(c.differences).toEqual([]);
    expect(c.note).toBe("1 room has no wall length or height, so it is not checked.");
  });

  it("a real difference among counted rooms is still listed, with the note", () => {
    const rooms = [
      room({ wallLengths: "20", materialHeight: "8'" }),
      room({ roomName: "Prep", roomNumber: "102", wallLengths: "30" }),
      room({ roomName: "Store", roomNumber: "103", materialHeight: "10'" }),
    ];
    const rows: SheetRow[] = [{ sheetsNeeded: 7, sheetSize: "4x8", pricePerSheet: 0, sheetsSource: "typed" }];
    const c = countCheck(rooms, rows);
    expect(c.words).toEqual(["4x8: the walls need 5, your rows hold 7"]);
    expect(c.note).toBe("2 rooms have no wall length or height, so they are not checked.");
  });

  it("a size no counted room uses is still 'need 0' when every uncounted room has another known size", () => {
    const rooms = [
      room({ wallLengths: "20", materialHeight: "8'" }),
      room({ roomName: "Store", roomNumber: "103", materialHeight: "8'" }), // no walls, but a 4x8 room
    ];
    const rows: SheetRow[] = [
      ...applySuggestions([], rooms, []),
      { sheetsNeeded: 12, sheetSize: "4x12", pricePerSheet: 0, sheetsSource: "typed" },
    ];
    expect(countCheck(rooms, rows).words).toEqual(["4x12: the walls need 0, your rows hold 12"]);
  });
});

describe("the fingerprint ties a confirmation to what he saw (MAJOR-R4-2)", () => {
  const rooms = [
    room({ wallLengths: "20", materialHeight: "8'" }),
    room({ roomName: "Prep", roomNumber: "102", wallLengths: "20", materialHeight: "10'" }),
  ];
  const ryan: SheetRow[] = [
    { sheetsNeeded: 5, sheetSize: "4x8", pricePerSheet: 0, sheetsSource: "suggested", rules: 3 },
    { sheetsNeeded: 6, sheetSize: "4x10", pricePerSheet: 0, sheetsSource: "typed" },
  ];
  const mike: SheetRow[] = [...ryan, { sheetsNeeded: 20, sheetSize: "4x12", pricePerSheet: 0, sheetsSource: "typed" }];

  it("changes when another person adds 20 x 4x12, and stays the same for the same rows", () => {
    const a = countCheck(rooms, ryan);
    expect(a.fingerprint).toBe(countCheck(rooms, ryan.map((r) => ({ ...r }))).fingerprint);
    expect(countCheck(rooms, mike).fingerprint).not.toBe(a.fingerprint);
    expect(a.fingerprint.length).toBeGreaterThan(0);
  });
});
