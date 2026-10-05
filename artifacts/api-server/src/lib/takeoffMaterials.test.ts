/**
 * Tests for glue and moldings (the client's answer 2), prices left blank
 * (answer 4) and the Material list. Pure: no database, no network.
 */
import { describe, it, expect } from "vitest";
import {
  GLUE_SHEETS_PER_BUCKET,
  computeCosts,
  glueBuckets,
  moldingLengthForSheet,
  moldingLines,
  savedTotalPrice,
  setMoldingCount,
  tidyMoldingCounts,
  type CostInput,
  type SheetRow,
} from "./takeoffRules";
import { buildProposalValues, checkProposalForExport } from "./proposalRules";

const rows = (): SheetRow[] => [
  { sheetsNeeded: 9, sheetSize: "4x8", pricePerSheet: 0, sheetsSource: "suggested" },
  { sheetsNeeded: 16, sheetSize: "4x10", pricePerSheet: 0, sheetsSource: "suggested" },
];

describe("glue", () => {
  it("his rule: one bucket does 12 sheets of any height", () => {
    expect(GLUE_SHEETS_PER_BUCKET).toBe(12);
    expect(glueBuckets(12).buckets).toBe(1);
    expect(glueBuckets(24).buckets).toBe(2);
  });

  it("rounds up to whole buckets", () => {
    expect(glueBuckets(1).buckets).toBe(1);
    expect(glueBuckets(13).buckets).toBe(2);
    expect(glueBuckets(25).buckets).toBe(3);
  });

  it("no sheets, no glue", () => {
    expect(glueBuckets(0)).toEqual({ buckets: 0, arithmetic: "no sheets, so no glue" });
  });

  it("shows its working", () => {
    expect(glueBuckets(25).arithmetic).toBe("25 sheets ÷ 12 a bucket = 2.08, rounded up to 3 buckets");
    expect(glueBuckets(24).arithmetic).toBe("24 sheets ÷ 12 a bucket = 2 buckets");
    expect(glueBuckets(5).arithmetic).toBe("5 sheets ÷ 12 a bucket = 0.42, rounded up to 1 bucket");
  });
});

describe("molding length", () => {
  it("his rule: 8 ft molding for sheets 8 ft high or less, 10 ft molding above", () => {
    expect(moldingLengthForSheet("4x4")).toBe(8);
    expect(moldingLengthForSheet("4x8")).toBe(8);
    expect(moldingLengthForSheet("4x10")).toBe(10);
    expect(moldingLengthForSheet("4x12")).toBe(10);
  });
});

describe("molding counts", () => {
  it("starts from one molding per sheet, and says it is an assumption (no count rule is invented)", () => {
    expect(moldingLines(rows())).toEqual([
      { lengthFt: 8, sheets: 9, suggested: 9, count: 9, typed: false },
      { lengthFt: 10, sheets: 16, suggested: 16, count: 16, typed: false },
    ]);
  });

  it("puts 4x10 and 4x12 sheets on the same 10 ft molding line", () => {
    const three: SheetRow[] = [...rows(), { sheetsNeeded: 3, sheetSize: "4x12", pricePerSheet: 0 }];
    expect(moldingLines(three)[1]).toMatchObject({ lengthFt: 10, sheets: 19, count: 19 });
  });

  it("the count he types replaces the suggestion for that length only", () => {
    const typed = setMoldingCount(rows(), 10, 22);
    expect(moldingLines(typed)).toEqual([
      { lengthFt: 8, sheets: 9, suggested: 9, count: 9, typed: false },
      { lengthFt: 10, sheets: 16, suggested: 16, count: 22, typed: true },
    ]);
    expect(typed[0]!.moldingCount ?? null).toBeNull();
    expect(typed[1]!.moldingCount).toBe(22);
  });

  it("a typed count stays when the sheet count changes", () => {
    const typed = setMoldingCount(rows(), 8, 14);
    typed[0] = { ...typed[0]!, sheetsNeeded: 30 };
    expect(moldingLines(typed)[0]).toEqual({ lengthFt: 8, sheets: 30, suggested: 30, count: 14, typed: true });
  });

  it("clearing the typed count goes back to the suggestion", () => {
    const cleared = setMoldingCount(setMoldingCount(rows(), 8, 14), 8, null);
    expect(moldingLines(cleared)[0]).toMatchObject({ count: 9, typed: false });
  });

  it("a typed zero is a count, not a blank", () => {
    expect(moldingLines(setMoldingCount(rows(), 8, 0))[0]).toMatchObject({ count: 0, typed: true });
  });

  it("every sheet row of a length carries that length's typed count", () => {
    const typed = setMoldingCount(rows(), 10, 22);
    const added: SheetRow[] = [...typed, { sheetsNeeded: 3, sheetSize: "4x12", pricePerSheet: 0, sheetsSource: "typed" }];
    const tidy = tidyMoldingCounts(added);
    expect(tidy[2]!.moldingCount).toBe(22);
    expect(moldingLines(tidy)[1]).toMatchObject({ sheets: 19, count: 22, typed: true });
    // and a row of the other length is left alone
    expect(tidy[0]!.moldingCount ?? null).toBeNull();
  });

  it("a length with no sheets has no moldings", () => {
    const only8: SheetRow[] = [{ sheetsNeeded: 5, sheetSize: "4x8", pricePerSheet: 0 }];
    expect(moldingLines(only8)[1]).toEqual({ lengthFt: 10, sheets: 0, suggested: 0, count: 0, typed: false });
  });
});

// ---------------------------------------------------------------------------
// Prices are optional (the client's answer 4)
// ---------------------------------------------------------------------------

const blank: CostInput = {
  sheetRows: rows(),
  laborRate: 0,
  laborDays: 0,
  laborHoursPerDay: 0,
  travelMiles: 0,
  hotelNights: 0,
  freight: 0,
  profitOverride: null,
};

const priced: CostInput = {
  sheetRows: [
    { sheetsNeeded: 9, sheetSize: "4x8", pricePerSheet: 45.5 },
    { sheetsNeeded: 16, sheetSize: "4x10", pricePerSheet: 58.25 },
  ],
  laborRate: 65,
  laborDays: 2,
  laborHoursPerDay: 8,
  travelMiles: 40,
  hotelNights: 1,
  freight: 150,
  profitOverride: null,
};

describe("a takeoff with every price left blank", () => {
  const c = computeCosts(blank);

  it("still works and still counts the quantities", () => {
    expect(c.totalSheets).toBe(25);
    expect(glueBuckets(c.totalSheets).buckets).toBe(3);
    expect(Number.isFinite(c.total)).toBe(true);
  });

  it("says what is not priced instead of showing $0.00 as a price", () => {
    expect(c.materialsPriced).toBe(false);
    expect(c.laborPriced).toBe(false);
    expect(c.fullyPriced).toBe(false);
    expect(c.notPriced).toEqual(["sheet prices (4x8, 4x10)", "labor"]);
  });

  it("is saved with no total, so nothing downstream can mistake it for a price", () => {
    expect(savedTotalPrice(blank)).toBe(0);
    expect(savedTotalPrice({ ...blank, sheetRows: rows().slice(0, 1).map((r) => ({ ...r, sheetsNeeded: 5 })) })).toBe(0);
  });
});

describe("a takeoff with prices typed", () => {
  const c = computeCosts(priced);

  it("is fully priced and adds up exactly as before", () => {
    expect(c.materialsPriced).toBe(true);
    expect(c.laborPriced).toBe(true);
    expect(c.fullyPriced).toBe(true);
    expect(c.notPriced).toEqual([]);
    // 409.50 + 932.00 materials, 1,040 labor, 480 travel, 375 hotel, 150 freight, 2,000 profit
    expect(c.total).toBe(9 * 45.5 + 16 * 58.25 + 65 * 2 * 8 + 0 + 480 + 375 + 150 + 2000);
    expect(savedTotalPrice(priced)).toBe(5386.5);
  });

  it("one sheet row without a price leaves materials not priced, and names the size", () => {
    const partly = computeCosts({
      ...priced,
      sheetRows: [priced.sheetRows[0]!, { ...priced.sheetRows[1]!, pricePerSheet: 0 }],
    });
    expect(partly.materialsPriced).toBe(false);
    expect(partly.fullyPriced).toBe(false);
    expect(partly.notPriced).toEqual(["sheet prices (4x10)"]);
  });

  it("a row with no sheets needs no price", () => {
    const withEmptyRow = computeCosts({
      ...priced,
      sheetRows: [...priced.sheetRows, { sheetsNeeded: 0, sheetSize: "4x12", pricePerSheet: 0 }],
    });
    expect(withEmptyRow.materialsPriced).toBe(true);
  });

  it("labor needs a rate, days and hours a day", () => {
    expect(computeCosts({ ...priced, laborRate: 0 }).notPriced).toEqual(["labor"]);
    expect(computeCosts({ ...priced, laborDays: 0 }).laborPriced).toBe(false);
    expect(computeCosts({ ...priced, laborHoursPerDay: 0 }).laborPriced).toBe(false);
  });

  it("a takeoff with no sheets at all is not priced", () => {
    const none = computeCosts({ ...priced, sheetRows: [] });
    expect(none.materialsPriced).toBe(false);
    expect(none.notPriced).toEqual(["sheets (none yet)"]);
  });
});

describe("the proposal price when prices are optional", () => {
  const job = { jobName: "Taco Shop TI", address: "100 Main St", city: "Rocklin" };
  const now = new Date("2026-10-05T19:00:00Z");
  const base = { roomRows: [], thickness: ".090" };

  it("takes the takeoff total when the takeoff is fully priced", () => {
    const p = buildProposalValues({ job, takeoff: { ...base, ...priced }, textures: [], now, existing: null });
    expect(p.priceAmount).toBe(5386.5);
    expect(p.priceInWords).toBe("Five Thousand Three Hundred Eighty-Six Dollars and Fifty Cents");
  });

  it("has no price (not a made-up total) when the takeoff has no prices", () => {
    const p = buildProposalValues({ job, takeoff: { ...base, ...blank }, textures: [], now, existing: null });
    expect(p.priceAmount).toBe(0);
    expect(p.priceInWords).toBe("");
    expect(p.frp).toContain("An allotment of 9 4x8 and 16 4x10 sheets only.");
    // and it cannot be exported until a total is typed
    expect(checkProposalForExport({ frp: "FRP", priceAmount: "" }).problems).toHaveLength(1);
  });

  it("keeps the total he typed when the takeoff still has no prices", () => {
    const first = buildProposalValues({ job, takeoff: { ...base, ...blank }, textures: [], now, existing: null });
    const typed = { ...first, priceAmount: 4100, priceInWords: "Four Thousand One Hundred Dollars" };
    const again = buildProposalValues({ job, takeoff: { ...base, ...blank }, textures: [], now, existing: typed });
    expect(again.priceAmount).toBe(4100);
    expect(again.priceInWords).toBe("Four Thousand One Hundred Dollars");
  });

  it("a partly priced takeoff never sends its part-total to the proposal", () => {
    const partly = { ...base, ...priced, laborRate: 0 };
    const p = buildProposalValues({ job, takeoff: partly, textures: [], now, existing: null });
    expect(p.priceAmount).toBe(0);
  });
});
