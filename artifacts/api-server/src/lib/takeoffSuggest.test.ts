/**
 * Tests for the suggested sheet count (the client's answers 2 and 3):
 * wall lengths, panel height, sheet size, sheets per room, sheet rows.
 * Pure: no database, no network.
 */
import { describe, it, expect } from "vitest";
import {
  CURRENT_RULES,
  applySuggestions,
  draftRoomRows,
  linearFootage,
  readHeight,
  readWallLengths,
  refreshSuggestedRows,
  resolvePanelHeight,
  sheetSizeForHeight,
  suggestRoom,
  suggestSheets,
  type RoomRow,
  type SheetRow,
} from "./takeoffRules";

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

describe("wall lengths in feet and inches", () => {
  it("reads feet and inches as one length (8'-6\" is 8.5 ft, not 8 + 6)", () => {
    expect(readWallLengths("8'-6\" + 8'-6\"").feet).toBe(17);
    expect(linearFootage("8'-6\" + 8'-6\"")).toBe(17);
    expect(readWallLengths("12'-6\", 10'").feet).toBe(22.5);
    expect(readWallLengths("8' 6\"").feet).toBe(8.5);
    expect(readWallLengths("8 ft 6 in").feet).toBe(8.5);
    expect(readWallLengths("96\"").feet).toBe(8);
    expect(readWallLengths("8'-6 1/2\"").feet).toBeCloseTo(8 + 6.5 / 12, 6);
  });

  it("still reads what the old box accepted, to the same total", () => {
    expect(readWallLengths("8 + 8 + 8.5, 12").feet).toBe(36.5);
    expect(readWallLengths("8 8 8.5").feet).toBe(24.5);
    expect(readWallLengths("").feet).toBe(0);
    expect(readWallLengths("").ok).toBe(true);
  });

  it("reads a number that is still being typed (12. is 12)", () => {
    expect(readWallLengths("12 + 12.")).toMatchObject({ ok: true, feet: 24 });
    expect(readWallLengths("12 + ")).toMatchObject({ ok: true, feet: 12 });
  });

  it("adds inches exactly (three walls of 5'-4\" are 16 ft, not 16.000000000000004)", () => {
    expect(readWallLengths("5'-4\" + 5'-4\" + 5'-4\"").feet).toBe(16);
  });

  it("says which part it cannot read instead of guessing", () => {
    const r = readWallLengths("12 + about 30 + 8");
    expect(r.ok).toBe(false);
    expect(r.unread).toEqual(["about 30"]);
    expect(readWallLengths("8 x 4").ok).toBe(false);
  });
});

describe("panel height", () => {
  it("reads a typed height", () => {
    expect(readHeight("8'-0\"").feet).toBe(8);
    expect(readHeight("9'").feet).toBe(9);
    expect(readHeight("9").feet).toBe(9);
    expect(readHeight("3'-8\"").feet).toBeCloseTo(3 + 8 / 12, 6);
    expect(readHeight("48\"").feet).toBe(4);
    expect(readHeight("10'-0\" A.F.F.").feet).toBe(10);
  });

  it("knows 'to ceiling' is not a number", () => {
    expect(readHeight("to ceiling")).toMatchObject({ feet: null, toCeiling: true, unread: false });
    expect(readHeight("Full height")).toMatchObject({ feet: null, toCeiling: true });
  });

  it("does not guess at a height it cannot read", () => {
    expect(readHeight("see elevation")).toMatchObject({ feet: null, toCeiling: false, unread: true });
    // a bare 48 is far more likely inches than a 48 ft wall
    expect(readHeight("48")).toMatchObject({ feet: null, unread: true });
  });

  it("uses the panel height when the room has one", () => {
    const h = resolvePanelHeight(room({ materialHeight: "8'-0\"", ceilingHeight: "10'-0\"" }));
    expect(h).toMatchObject({ feet: 8, source: "typed", assumed: false });
  });

  it("his rule: no FRP height means floor to ceiling, and the row says so", () => {
    const h = resolvePanelHeight(room({ materialHeight: null, ceilingHeight: "10'-0\"" }));
    expect(h).toMatchObject({ feet: 10, source: "ceiling", assumed: true, note: "assumed to ceiling" });
    const blank = resolvePanelHeight(room({ materialHeight: "  ", ceilingHeight: "9" }));
    expect(blank).toMatchObject({ feet: 9, source: "ceiling", assumed: true });
  });

  it("'to ceiling' on the plans uses the ceiling height without calling it an assumption", () => {
    const h = resolvePanelHeight(room({ materialHeight: "to ceiling", ceilingHeight: "9'-0\"" }));
    expect(h).toMatchObject({ feet: 9, source: "ceiling", assumed: false });
  });

  it("has no height when neither is known, and says what to type", () => {
    const h = resolvePanelHeight(room());
    expect(h.feet).toBeNull();
    expect(h.source).toBe("none");
    expect(h.note).toMatch(/height/);
  });

  it("never falls back to the ceiling when a typed height cannot be read", () => {
    const h = resolvePanelHeight(room({ materialHeight: "see elevation", ceilingHeight: "10'" }));
    expect(h.feet).toBeNull();
    expect(h.source).toBe("none");
  });

  it("a draft row keeps the room's own heights: the ceiling is not copied into the panel height", () => {
    const rows = draftRoomRows([
      { roomName: "Restroom", roomNumber: "108", materialHeight: null, ceilingHeight: "10'-0\"", manufacturer: null, color: "White", productCode: "FRP-1", fireRating: "Class C" },
      { roomName: "Kitchen", roomNumber: "101", materialHeight: "8'-0\"", ceilingHeight: "9'-0\"", manufacturer: null, color: null, productCode: null, fireRating: null },
    ]);
    expect(rows[0]).toMatchObject({ materialHeight: null, ceilingHeight: "10'-0\"", wallLengths: "", moldingType: null });
    expect(resolvePanelHeight(rows[0]!)).toMatchObject({ feet: 10, assumed: true });
    expect(resolvePanelHeight(rows[1]!)).toMatchObject({ feet: 8, assumed: false });
  });
});

describe("sheet size for a panel height", () => {
  it("is the shortest of his sizes that covers the height", () => {
    expect(sheetSizeForHeight(4)).toBe("4x8");
    expect(sheetSizeForHeight(8)).toBe("4x8");
    expect(sheetSizeForHeight(8.01)).toBe("4x10");
    expect(sheetSizeForHeight(9)).toBe("4x10");
    expect(sheetSizeForHeight(10)).toBe("4x10");
    expect(sheetSizeForHeight(10.5)).toBe("4x12");
    expect(sheetSizeForHeight(12)).toBe("4x12");
  });
});

describe("suggested sheets for a room", () => {
  // Update 2 (his answer 4): each wall is rounded up to the next 4 ft first,
  // and a room is no longer rounded on its own (the job rounds once per size).
  it("is the counted wall divided by the 4 ft sheet width", () => {
    const s = suggestRoom(room({ wallLengths: "12 + 12 + 10", materialHeight: "9'" }));
    expect(s.sheets).toBe(9); // 12 + 12 + 12 = 36 / 4
    expect(s.sheetSize).toBe("4x10");
    expect(s.wallWorking).toBe("12 ft + 12 ft + 10 ft counted as 12 ft = 36 ft");
    expect(s.arithmetic).toBe("36 ft ÷ 4 ft a sheet = 9 sheets of 4x10");
  });

  it("an exact fit stays as it is", () => {
    const s = suggestRoom(room({ wallLengths: "8 + 8 + 8 + 8", materialHeight: "8'-0\"" }));
    expect(s.sheets).toBe(8);
    expect(s.sheetSize).toBe("4x8");
    expect(s.arithmetic).toBe("32 ft ÷ 4 ft a sheet = 8 sheets of 4x8");
    // three walls of 5'-4" each count as 8 ft
    expect(suggestRoom(room({ wallLengths: "5'-4\" + 5'-4\" + 5'-4\"", materialHeight: "8" })).sheets).toBe(6);
  });

  it("adds no waste and takes out no openings: the walls are measured through doors and windows", () => {
    // 40 ft of wall is 10 sheets whatever doors are in it; nothing is added on top
    expect(suggestRoom(room({ wallLengths: "40", materialHeight: "8" })).sheets).toBe(10);
    // 40.5 ft as one wall counts as 44 ft
    expect(suggestRoom(room({ wallLengths: "40.5", materialHeight: "8" })).sheets).toBe(11);
  });

  it("uses the ceiling height when there is no panel height", () => {
    const s = suggestRoom(room({ wallLengths: "12 + 12", ceilingHeight: "10'-0\"" }));
    expect(s.sheets).toBe(6);
    expect(s.sheetSize).toBe("4x10");
    expect(s.height.assumed).toBe(true);
  });

  it("a panel taller than his longest sheet is never counted as one row of sheets", () => {
    // on its own (no other sheet size on the job) it asks for the courses
    const tall = suggestRoom(room({ wallLengths: "40", ceilingHeight: "14'-0\"" }));
    expect(tall.sheets).toBeNull();
    expect(tall.problem).toMatch(/14 ft.*taller than a 12 ft sheet/);
    expect(suggestRoom(room({ wallLengths: "40", materialHeight: "12'" })).problem).toBeNull();
  });

  it("a panel above 4 ft is an upright sheet: 4.01 ft and 8 ft", () => {
    const justOver = suggestRoom(room({ wallLengths: "12 + 12 + 10", materialHeight: "4.01" }));
    expect(justOver.sheets).toBe(9);
    expect(justOver.sheetSize).toBe("4x8");
    expect(justOver.layout).toBe("upright");
    expect(suggestRoom(room({ wallLengths: "12 + 12 + 10", materialHeight: "4'-0 1/2\"" })).layout).toBe("upright");
    const eight = suggestRoom(room({ wallLengths: "12 + 12 + 10", materialHeight: "8'" }));
    expect(eight.sheets).toBe(9);
    expect(eight.warning).toBeNull();
  });

  it("suggests nothing, and says why, without a wall length or a height", () => {
    expect(suggestRoom(room({ materialHeight: "8" }))).toMatchObject({ sheets: null, sheetSize: "4x8" });
    expect(suggestRoom(room({ materialHeight: "8" })).problem).toMatch(/wall length/);
    const noHeight = suggestRoom(room({ wallLengths: "20" }));
    expect(noHeight.sheets).toBeNull();
    expect(noHeight.problem).toMatch(/height/);
    const unread = suggestRoom(room({ wallLengths: "12 + about 30", materialHeight: "8" }));
    expect(unread.sheets).toBeNull();
    expect(unread.problem).toMatch(/about 30/);
  });
});

describe("suggested sheet rows for the job", () => {
  const rooms: RoomRow[] = [
    room({ roomName: "Kitchen", wallLengths: "12 + 12 + 10", materialHeight: "8'" }), // 12 + 12 + 12 = 36 ft -> 9 x 4x8
    room({ roomName: "Prep", wallLengths: "12 + 12 + 8 + 8", materialHeight: "9'" }), // 40 ft -> 10 x 4x10 (10 + 10 + 10 + 10 would now count as 48 ft)
    room({ roomName: "Restroom", wallLengths: "8 + 8 + 4 + 4", ceilingHeight: "10'" }), // 24 ft -> 6 x 4x10, assumed
  ];

  it("adds the rooms up by sheet size (rounded up once per size)", () => {
    const s = suggestSheets(rooms);
    expect(s.bySize).toEqual({ "4x4": 0, "4x8": 9, "4x10": 16, "4x12": 0 });
    expect(s.rooms.map((r) => r.sheets)).toEqual([9, 10, 6]);
  });

  it("fills empty sheet rows with the suggestion, marked as suggested", () => {
    expect(applySuggestions([], rooms, [])).toEqual([
      { sheetsNeeded: 9, sheetSize: "4x8", pricePerSheet: 0, sheetsSource: "suggested", rules: CURRENT_RULES },
      { sheetsNeeded: 16, sheetSize: "4x10", pricePerSheet: 0, sheetsSource: "suggested", rules: CURRENT_RULES },
    ]);
  });

  it("a suggested row follows the wall lengths", () => {
    const rows = applySuggestions([], rooms, []);
    const longer = rooms.map((r, i) => (i === 0 ? { ...r, wallLengths: "12 + 12 + 10 + 10" } : r));
    expect(applySuggestions(rooms, longer, rows)[0]).toMatchObject({ sheetsNeeded: 12, sheetsSource: "suggested", rules: CURRENT_RULES });
  });

  it("a row he typed over is never changed behind his back", () => {
    const rows = applySuggestions([], rooms, []);
    rows[0] = { ...rows[0]!, sheetsNeeded: 12, sheetsSource: "typed" };
    const longer = rooms.map((r, i) => (i === 0 ? { ...r, wallLengths: "12 + 12 + 10 + 10" } : r));
    const after = applySuggestions(rooms, longer, rows);
    expect(after[0]).toMatchObject({ sheetsNeeded: 12, sheetSize: "4x8", pricePerSheet: 0, sheetsSource: "typed" });
    expect(after).toHaveLength(2); // and no second 4x8 row is slipped in beside his
    expect(refreshSuggestedRows(longer, rows)[0]).toMatchObject({ sheetsNeeded: 12, sheetsSource: "typed" });
  });

  it("rows saved before this update have no mark and count as his", () => {
    const old: SheetRow[] = [{ sheetsNeeded: 20, sheetSize: "4x8", pricePerSheet: 45.5 }];
    expect(refreshSuggestedRows(rooms, old)).toEqual(old);
    const after = applySuggestions([], rooms, old);
    expect(after[0]).toEqual(old[0]);
    // the 4x10 rooms have no row at all yet, so that suggestion is offered as its own row
    expect(after[1]).toEqual({ sheetsNeeded: 16, sheetSize: "4x10", pricePerSheet: 0, sheetsSource: "suggested", rules: CURRENT_RULES });
  });

  it("a suggested row he deleted does not come back until the suggestion itself changes", () => {
    const rows = applySuggestions([], rooms, []).filter((r) => r.sheetSize !== "4x8");
    const renamed = rooms.map((r, i) => (i === 0 ? { ...r, roomName: "Main kitchen" } : r));
    expect(applySuggestions(rooms, renamed, rows).map((r) => r.sheetSize)).toEqual(["4x10"]);
  });

  it("a suggested row that comes back takes its place in size order, not the end of the list", () => {
    const only10 = applySuggestions([], rooms, []).filter((r) => r.sheetSize !== "4x8");
    const longer = rooms.map((r, i) => (i === 0 ? { ...r, wallLengths: "12 + 12 + 10 + 10" } : r));
    expect(applySuggestions(rooms, longer, only10).map((r) => r.sheetsNeeded + " " + r.sheetSize)).toEqual([
      "12 4x8",
      "16 4x10",
    ]);
  });

  it("a suggested row with nothing typed in it goes away when its rooms do", () => {
    const rows = applySuggestions([], rooms, []);
    const fewer = rooms.slice(1);
    expect(applySuggestions(rooms, fewer, rows)).toEqual([
      { sheetsNeeded: 16, sheetSize: "4x10", pricePerSheet: 0, sheetsSource: "suggested", rules: CURRENT_RULES },
    ]);
  });

  it("the server refreshes suggested rows from the rooms, so a stale count is never stored", () => {
    const stale: SheetRow[] = [
      { sheetsNeeded: 3, sheetSize: "4x8", pricePerSheet: 0, sheetsSource: "suggested", rules: CURRENT_RULES },
      { sheetsNeeded: 7, sheetSize: "4x10", pricePerSheet: 50, sheetsSource: "typed" },
    ];
    expect(refreshSuggestedRows(rooms, stale)).toEqual([
      { sheetsNeeded: 9, sheetSize: "4x8", pricePerSheet: 0, sheetsSource: "suggested", rules: CURRENT_RULES },
      { sheetsNeeded: 7, sheetSize: "4x10", pricePerSheet: 50, sheetsSource: "typed" },
    ]);
  });
});
