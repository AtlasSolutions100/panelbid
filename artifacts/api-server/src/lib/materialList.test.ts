/**
 * Tests for the Material list ("that typed up sheet of: it's this many 4x10s,
 * this amount of molding, glue"). Pure: no database, no network.
 */
import { describe, it, expect } from "vitest";
import { buildMaterialList, materialListHtml, type MaterialListInput } from "./materialList";
import { CURRENT_RULES, applySuggestions, setMoldingCount, type RoomRow } from "./takeoffRules";

const room = (over: Partial<RoomRow>): RoomRow => ({
  roomName: null,
  roomNumber: null,
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

const rooms: RoomRow[] = [
  room({ roomName: "Kitchen", roomNumber: "101", wallLengths: "12 + 12 + 10", materialHeight: "8'-0\"", ceilingHeight: "9'-0\"" }),
  // Update 2: 12 + 12 + 8 + 8 so Prep still counts 40 ft (10 + 10 + 10 + 10 now counts as 48 ft).
  room({ roomName: "Prep", roomNumber: "102", wallLengths: "12 + 12 + 8 + 8", materialHeight: "9'-0\"", ceilingHeight: "10'-0\"" }),
  room({ roomName: "Restroom", roomNumber: "103", wallLengths: "6 + 6 + 5'-6\" + 5'-6\"", ceilingHeight: "10'-0\"" }),
];

const input = (over: Partial<MaterialListInput> = {}): MaterialListInput => ({
  jobName: "Sample Diner TI",
  address: "100 Example St",
  city: "Rocklin",
  date: "October 5, 2026",
  thickness: ".090",
  roomRows: rooms,
  sheetRows: applySuggestions([], rooms, []),
  ...over,
});

describe("material list", () => {
  const list = buildMaterialList(input());

  // Update 2: each wall counts up to the next 4 ft (Restroom: 6 + 6 + 5'-6" +
  // 5'-6" counts as 32 ft, 8 sheets), and moldings are counted by kind.
  it("lists the sheets by size", () => {
    expect(list.sheets).toEqual([
      { size: "4x8", count: 9, whose: "suggested", suggested: 9, price: null, total: null },
      { size: "4x10", count: 18, whose: "suggested", suggested: 18, price: null, total: null },
    ]);
    expect(list.totalSheets).toBe(27);
  });

  it("lists the moldings by kind and length, and the glue buckets", () => {
    expect(list.moldings.map((m) => [m.kind, m.lengthFt, m.count, m.typed])).toEqual([
      ["cap", 8, 9, false],
      ["divider", 8, 9, false],
      ["cap", 10, 18, false],
      ["divider", 10, 18, false],
    ]);
    expect(list.glue.buckets).toBe(3);
    expect(list.glue.arithmetic).toBe("27 sheets ÷ 12 a bucket = 2.25, rounded up to 3 buckets");
  });

  it("lists each room with its wall length, height and working", () => {
    expect(list.rooms.map((r) => [r.label, r.wallFeet, r.heightText, r.sheets, r.sheetSize])).toEqual([
      ["Kitchen 101", 34, "8 ft", 9, "4x8"],
      ["Prep 102", 40, "9 ft", 10, "4x10"],
      ["Restroom 103", 23, "10 ft (assumed to ceiling)", 8, "4x10"],
    ]);
    expect(list.rooms[2]!.wallWorking).toBe(
      "6 ft counted as 8 ft + 6 ft counted as 8 ft + 5 ft 6 in counted as 8 ft + 5 ft 6 in counted as 8 ft = 32 ft",
    );
    expect(list.rooms[2]!.arithmetic).toBe("32 ft ÷ 4 ft a sheet = 8 sheets of 4x10");
  });

  it("states every assumption used, in plain words", () => {
    const all = list.assumptions.join("\n");
    expect(all).toMatch(/straight through doors and windows/);
    expect(all).toMatch(/no extra waste/i);
    expect(all).toMatch(/Restroom 103: no panel height.*floor to ceiling.*10 ft/);
    expect(all).toMatch(/rounded up to the next 4 ft.*ASSUMED/);
    expect(all).toMatch(/"Per sheet" is our reading of your words \(assumed\)/);
    expect(all).toMatch(/one bucket does 12 sheets/);
    // rooms whose height came from the plans are not listed as assumed
    expect(all).not.toMatch(/Kitchen 101: no panel height/);
  });

  it("has no prices on it when none were typed", () => {
    expect(list.showPrices).toBe(false);
    const html = materialListHtml(list);
    expect(html).not.toContain("$");
    expect(html).not.toMatch(/price/i);
    expect(html).toContain("MATERIAL LIST");
    expect(html).toContain("Sample Diner TI");
  });

  it("shows prices only when he typed them", () => {
    const priced = buildMaterialList(
      input({
        sheetRows: [
          { sheetsNeeded: 9, sheetSize: "4x8", pricePerSheet: 45.5, sheetsSource: "suggested" },
          { sheetsNeeded: 16, sheetSize: "4x10", pricePerSheet: 0, sheetsSource: "suggested" },
        ],
      }),
    );
    expect(priced.showPrices).toBe(true);
    expect(priced.sheets[0]).toMatchObject({ price: 45.5, total: 409.5 });
    expect(priced.sheets[1]).toMatchObject({ price: null, total: null });
    const html = materialListHtml(priced);
    expect(html).toContain("$45.50");
    expect(html).toContain("$409.50");
    expect(html).toContain("not priced");
    expect(html).not.toContain("$0.00");
  });

  it("says which counts are his own and what the wall lengths suggested", () => {
    const mine = buildMaterialList(
      input({
        sheetRows: setMoldingCount(
          [
            { sheetsNeeded: 12, sheetSize: "4x8", pricePerSheet: 0, sheetsSource: "typed" },
            { sheetsNeeded: 18, sheetSize: "4x10", pricePerSheet: 0, sheetsSource: "suggested", rules: CURRENT_RULES },
          ],
          10,
          22,
        ),
      }),
    );
    expect(mine.sheets[0]).toMatchObject({ size: "4x8", count: 12, whose: "yours", suggested: 9 });
    const all = mine.assumptions.join("\n");
    expect(all).toMatch(/4x8: 12 sheets is your own count \(the wall lengths suggest 9\)/);
    // a count typed per length (how update 1 kept it) is still his
    expect(all).toMatch(/10 ft molding: 22 is the count you typed before moldings were counted by kind/);
    expect(all).toMatch(/"Per sheet" is our reading of your words \(assumed\)/);
  });

  it("names a room that is not in the count, and why", () => {
    const withGap = buildMaterialList(
      input({ roomRows: [...rooms, room({ roomName: "Storage", roomNumber: "104", materialHeight: "8'" })] }),
    );
    expect(withGap.notCounted).toEqual(["Storage 104: not in the suggested count (no wall length typed)."]);
    expect(materialListHtml(withGap)).toContain("Storage 104");
  });

  it("a panel taller than a 12 ft sheet with nothing to start a stack from is listed as not counted", () => {
    const tall = buildMaterialList(
      input({ roomRows: [room({ roomName: "Warehouse", roomNumber: "120", wallLengths: "40", ceilingHeight: "14'" })], sheetRows: [] }),
    );
    expect(tall.notCounted.join("\n")).toMatch(/Warehouse 120: .*14 ft.*taller than a 12 ft sheet/);
    expect(buildMaterialList(input()).notCounted.join("\n")).not.toMatch(/taller than/);
  });

  // Update 2 (his answer 3): the count for a panel of 4 ft or less is now his
  // rule, a 4x8 on its side, so the old "may be about half" line is gone.
  it("a panel of 4 ft or less is counted as a 4x8 on its side", () => {
    const wainscot = (height: string) =>
      buildMaterialList(
        input({
          roomRows: [room({ roomName: "Dining", roomNumber: "110", wallLengths: "12 + 12 + 10", materialHeight: height })],
          sheetRows: applySuggestions([], [room({ wallLengths: "12 + 12 + 10", materialHeight: height })], []),
        }),
      );
    for (const height of ["4'", '48"']) {
      const list = wainscot(height);
      // 36 ft counted ÷ 8 ft a sheet = 4.5, rounded up to 5
      expect(list.sheets).toEqual([
        { size: "4x8", count: 5, whose: "suggested", suggested: 5, price: null, total: null },
      ]);
      expect(list.rooms[0]!.sheetsText).toBe("4.5 × 4x8 on its side");
      expect(materialListHtml(list)).not.toMatch(/about half/);
    }
    for (const height of ["4.01", "8'"]) {
      expect(wainscot(height).sheets[0]).toMatchObject({ count: 9 });
    }
  });

  it("escapes what a person typed before it goes into the printed page", () => {
    const html = materialListHtml(buildMaterialList(input({ jobName: "Bob's <b>Diner</b> & Grill" })));
    expect(html).toContain("Bob's &lt;b&gt;Diner&lt;/b&gt; &amp; Grill");
    expect(html).not.toContain("<b>Diner</b>");
  });
});
