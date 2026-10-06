/**
 * Repair 3 of update 2 (critic round 3). Pure: no database, no network.
 * - A SUGGESTED row always follows the walls, whatever other rows are typed;
 *   only ADDING a row of a new size beside a typed row stays his click.
 * - Before a proposal, sizes whose rows hold more or fewer sheets than the
 *   walls need are listed, and the proposal waits for his confirmation.
 */
import { describe, it, expect } from "vitest";
import {
  applySuggestions,
  convertToNewRules,
  countDifferences,
  countDifferenceWords,
  refreshSuggestedRows,
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

describe("BLOCKER-3: a typed row does not freeze the other suggested rows", () => {
  const rooms: RoomRow[] = [
    room({ roomName: "Kitchen", wallLengths: "20", materialHeight: "8'" }),
    room({ roomName: "Prep", roomNumber: "102", wallLengths: "20", materialHeight: "10'" }),
  ];
  const typedOver = (): SheetRow[] =>
    applySuggestions([], rooms, []).map((r) => (r.sheetSize === "4x10" ? { sheetsNeeded: 6, sheetSize: "4x10", pricePerSheet: 0, sheetsSource: "typed" } : r));
  const longer = rooms.map((r, i) => (i === 0 ? { ...r, wallLengths: "20 + 24" } : r));

  it("the suggested 4x8 row follows the kitchen to 11 in the page", () => {
    const after = applySuggestions(rooms, longer, typedOver());
    expect(after.map((r) => `${r.sheetsNeeded} ${r.sheetSize} ${r.sheetsSource}`)).toEqual([
      "11 4x8 suggested",
      "6 4x10 typed",
    ]);
  });

  it("the server's refresh (save and proposal) brings a stale suggested count up to the walls", () => {
    const stale = typedOver(); // 4x8 still 5
    const fresh = refreshSuggestedRows(longer, stale);
    expect(fresh[0]).toMatchObject({ sheetsNeeded: 11, sheetsSource: "suggested" });
    expect(fresh[1]).toEqual(stale[1]); // his typed row is never changed
    expect(sheetAllotment(fresh).phrase).toBe("11 4x8 and 6 4x10");
  });
});

describe("MAJOR-R3: before a proposal, a count that differs from the walls is listed", () => {
  // His typed 12 x 4x12 beside an earlier-suggested 4x10, then "Use the new counts".
  const rooms: RoomRow[] = [
    room({ roomName: "Prep", roomNumber: "102", wallLengths: "20", materialHeight: "10'" }),
    room({ roomName: "Cooler", roomNumber: "104", wallLengths: "24 + 2", materialHeight: "14'" }),
  ];
  const rows: SheetRow[] = [
    { sheetsNeeded: 5, sheetSize: "4x10", pricePerSheet: 0, sheetsSource: "suggested" },
    { sheetsNeeded: 12, sheetSize: "4x12", pricePerSheet: 0, sheetsSource: "typed" },
  ];

  it("the converted job holds 12 x 4x12 the walls do not need: listed in words", () => {
    const converted = convertToNewRules(rooms, rows).rows;
    const diffs = countDifferences(rooms, converted);
    expect(diffs).toEqual([{ size: "4x12", need: 0, have: 12 }]);
    expect(countDifferenceWords(diffs)).toEqual(["4x12: the walls need 0, your rows hold 12"]);
  });

  it("fewer sheets than the walls need are listed too", () => {
    const short: SheetRow[] = [{ sheetsNeeded: 3, sheetSize: "4x10", pricePerSheet: 0, sheetsSource: "typed" }];
    expect(countDifferenceWords(countDifferences([rooms[0]!], short))).toEqual([
      "4x10: the walls need 5, your rows hold 3",
    ]);
  });

  it("a job with only typed rows that match the walls has nothing to confirm", () => {
    const typed: SheetRow[] = [{ sheetsNeeded: 5, sheetSize: "4x10", pricePerSheet: 0, sheetsSource: "typed" }];
    expect(countDifferences([rooms[0]!], typed)).toEqual([]);
  });

  it("a job whose suggested rows follow the walls has nothing to confirm", () => {
    const r = [rooms[0]!];
    expect(countDifferences(r, applySuggestions([], r, []))).toEqual([]);
  });
});
