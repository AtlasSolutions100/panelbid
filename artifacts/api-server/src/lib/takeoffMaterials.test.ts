/**
 * Tests for glue and moldings (the client's answer 2), prices left blank
 * (answer 4) and the Material list. Pure: no database, no network.
 */
import { describe, it, expect } from "vitest";
import {
  GLUE_SHEETS_PER_BUCKET,
  glueBuckets,
  moldingLengthForSheet,
  moldingLines,
  setMoldingCount,
  tidyMoldingCounts,
  type SheetRow,
} from "./takeoffRules";

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
