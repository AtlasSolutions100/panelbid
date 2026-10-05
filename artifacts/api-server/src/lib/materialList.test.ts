/**
 * Tests for the Material list ("that typed up sheet of: it's this many 4x10s,
 * this amount of molding, glue"). Pure: no database, no network.
 */
import { describe, it, expect } from "vitest";
import { buildMaterialList, materialListHtml, type MaterialListInput } from "./materialList";
import { applySuggestions, setMoldingCount, type RoomRow } from "./takeoffRules";

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
  room({ roomName: "Prep", roomNumber: "102", wallLengths: "10 + 10 + 10 + 10", materialHeight: "9'-0\"", ceilingHeight: "10'-0\"" }),
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

  it("lists the sheets by size", () => {
    expect(list.sheets).toEqual([
      { size: "4x8", count: 9, whose: "suggested", suggested: 9, price: null, total: null },
      { size: "4x10", count: 16, whose: "suggested", suggested: 16, price: null, total: null },
    ]);
    expect(list.totalSheets).toBe(25);
  });

  it("lists the moldings by length and the glue buckets", () => {
    expect(list.moldings).toEqual([
      { lengthFt: 8, sheets: 9, suggested: 9, count: 9, typed: false },
      { lengthFt: 10, sheets: 16, suggested: 16, count: 16, typed: false },
    ]);
    expect(list.glue.buckets).toBe(3);
    expect(list.glue.arithmetic).toBe("25 sheets ÷ 12 a bucket = 2.08, rounded up to 3 buckets");
  });

  it("lists each room with its wall length, height and working", () => {
    expect(list.rooms.map((r) => [r.label, r.wallFeet, r.heightText, r.sheets, r.sheetSize])).toEqual([
      ["Kitchen 101", 34, "8 ft", 9, "4x8"],
      ["Prep 102", 40, "9 ft", 10, "4x10"],
      ["Restroom 103", 23, "10 ft (assumed to ceiling)", 6, "4x10"],
    ]);
    expect(list.rooms[2]!.arithmetic).toBe("23 ft of wall ÷ 4 ft a sheet = 5.75, rounded up to 6 sheets of 4x10");
  });

  it("states every assumption used, in plain words", () => {
    const all = list.assumptions.join("\n");
    expect(all).toMatch(/straight through doors and windows/);
    expect(all).toMatch(/no extra waste/i);
    expect(all).toMatch(/Restroom 103: no panel height.*floor to ceiling.*10 ft/);
    expect(all).toMatch(/8 ft molding.*ASSUMED.*one per sheet/);
    expect(all).toMatch(/10 ft molding.*ASSUMED.*one per sheet/);
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
            { sheetsNeeded: 16, sheetSize: "4x10", pricePerSheet: 0, sheetsSource: "suggested" },
          ],
          10,
          22,
        ),
      }),
    );
    expect(mine.sheets[0]).toMatchObject({ size: "4x8", count: 12, whose: "yours", suggested: 9 });
    const all = mine.assumptions.join("\n");
    expect(all).toMatch(/4x8: 12 sheets is your own count \(the wall lengths suggest 9\)/);
    expect(all).toMatch(/10 ft molding: 22 is your own count/);
    expect(all).toMatch(/8 ft molding.*ASSUMED/);
  });

  it("names a room that is not in the count, and why", () => {
    const withGap = buildMaterialList(
      input({ roomRows: [...rooms, room({ roomName: "Storage", roomNumber: "104", materialHeight: "8'" })] }),
    );
    expect(withGap.notCounted).toEqual(["Storage 104: not in the suggested count (no wall length typed)."]);
    expect(materialListHtml(withGap)).toContain("Storage 104");
  });

  it("warns on the list when a panel is taller than a 12 ft sheet", () => {
    const tall = buildMaterialList(
      input({ roomRows: [room({ roomName: "Warehouse", roomNumber: "120", wallLengths: "40", ceilingHeight: "14'" })], sheetRows: [] }),
    );
    expect(tall.assumptions.join("\n")).toMatch(/Warehouse 120: .*14 ft.*taller than a 12 ft sheet/);
    expect(buildMaterialList(input()).assumptions.join("\n")).not.toMatch(/taller than/);
  });

  it("escapes what a person typed before it goes into the printed page", () => {
    const html = materialListHtml(buildMaterialList(input({ jobName: "Bob's <b>Diner</b> & Grill" })));
    expect(html).toContain("Bob's &lt;b&gt;Diner&lt;/b&gt; &amp; Grill");
    expect(html).not.toContain("<b>Diner</b>");
  });
});
