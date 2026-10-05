/**
 * Tests for the takeoff rules. Pure: no database, no network.
 */
import { describe, it, expect } from "vitest";
import {
  amountInWords,
  computeCosts,
  flatProfitApplies,
  linearFootage,
  parseWallLengths,
  readTypedAmount,
  resolvePricePerSheet,
  roundToCents,
  sameJson,
  sheetAreaSqft,
  totalSheets,
  type CostInput,
  type SheetRow,
} from "./takeoffRules";

const sheets = (n: number, price = 45.5): SheetRow[] => [
  { sheetsNeeded: n, sheetSize: "4x8", pricePerSheet: price },
];

const base: CostInput = {
  sheetRows: [
    { sheetsNeeded: 12, sheetSize: "4x8", pricePerSheet: 45.5 },
    { sheetsNeeded: 6, sheetSize: "4x10", pricePerSheet: 58.25 },
  ],
  laborRate: 65,
  laborDays: 1.25,
  laborHoursPerDay: 10.25,
  travelMiles: 40,
  hotelNights: 1,
  freight: 150,
  profitOverride: null,
};

describe("wall lengths", () => {
  it("reads plain numbers joined by + or commas", () => {
    expect(parseWallLengths("8 + 8 + 8.5, 12")).toEqual([8, 8, 8.5, 12]);
    expect(linearFootage("8 + 8 + 8.5, 12")).toBe(36.5);
  });

  it("an empty box is zero feet", () => {
    expect(linearFootage("")).toBe(0);
  });
});

describe("sheets", () => {
  it("knows the area of each sheet size", () => {
    expect(sheetAreaSqft("4x4")).toBe(16);
    expect(sheetAreaSqft("4x8")).toBe(32);
    expect(sheetAreaSqft("4x10")).toBe(40);
    expect(sheetAreaSqft("4x12")).toBe(48);
  });

  it("adds the sheet rows", () => {
    expect(totalSheets(base.sheetRows)).toBe(18);
    expect(totalSheets([])).toBe(0);
  });

  it("takes the printed price per sheet, else price per sqft x area", () => {
    expect(resolvePricePerSheet({ pricePerSheet: 41, pricePerSqft: 1.5 }, "4x8")).toBe(41);
    expect(resolvePricePerSheet({ pricePerSheet: null, pricePerSqft: 1.337 }, "4x10")).toBe(53.48);
    expect(resolvePricePerSheet({ pricePerSheet: null, pricePerSqft: null }, "4x8")).toBeNull();
  });
});

describe("cost lines and the total", () => {
  it("works each line out the way the takeoff sheet always has", () => {
    const c = computeCosts(base);
    expect(c.totalSheets).toBe(18);
    expect(c.materials).toBe(12 * 45.5 + 6 * 58.25);
    expect(c.labor).toBe(65 * 1.25 * 10.25);
    expect(c.overtimeHours).toBe(0.25 * 1.25);
    expect(c.overtime).toBe(0.25 * 1.25 * 34);
    expect(c.travel).toBe(40 * 12);
    expect(c.hotel).toBe(375);
    expect(c.freight).toBe(150);
    expect(c.autoProfit).toBe(1250);
    expect(c.profit).toBe(1250);
    expect(c.total).toBe(
      12 * 45.5 + 6 * 58.25 + 65 * 1.25 * 10.25 + 0.25 * 1.25 * 34 + 480 + 375 + 150 + 1250,
    );
  });

  it("charges no overtime at 10 hours a day or less", () => {
    const c = computeCosts({ ...base, laborHoursPerDay: 10 });
    expect(c.overtimeHours).toBe(0);
    expect(c.overtime).toBe(0);
  });

  it("a typed profit replaces the automatic one", () => {
    const c = computeCosts({ ...base, profitOverride: 500 });
    expect(c.autoProfit).toBe(1250);
    expect(c.profit).toBe(500);
    expect(c.total).toBe(computeCosts(base).total - 1250 + 500);
  });
});

describe("profit rule", () => {
  it("is $800 flat on a small job", () => {
    expect(flatProfitApplies(7)).toBe(true);
    expect(computeCosts({ ...base, sheetRows: sheets(7) }).autoProfit).toBe(800);
  });

  it("is $1,000 a labor day on a bigger job", () => {
    expect(flatProfitApplies(9)).toBe(false);
    expect(computeCosts({ ...base, sheetRows: sheets(9), laborDays: 2 }).autoProfit).toBe(2000);
  });

  it("old rule: exactly 8 sheets is NOT flat", () => {
    expect(flatProfitApplies(8)).toBe(false);
    expect(computeCosts({ ...base, sheetRows: sheets(8), laborDays: 2 }).autoProfit).toBe(2000);
  });
});

describe("typed dollar amounts", () => {
  it("reads a plain amount", () => {
    expect(readTypedAmount("4100.50")).toEqual({ ok: true, amount: 4100.5 });
    expect(readTypedAmount("4100")).toEqual({ ok: true, amount: 4100 });
    expect(readTypedAmount(" 87.5 ")).toEqual({ ok: true, amount: 87.5 });
  });

  it("reads commas as thousands separators (4,100.00 is four thousand one hundred)", () => {
    expect(readTypedAmount("4,100.00")).toEqual({ ok: true, amount: 4100 });
    expect(readTypedAmount("$4,100")).toEqual({ ok: true, amount: 4100 });
    expect(readTypedAmount("$ 4,100.5")).toEqual({ ok: true, amount: 4100.5 });
    expect(readTypedAmount("1,234,567.89")).toEqual({ ok: true, amount: 1234567.89 });
  });

  it("refuses anything unclear, and says why in words", () => {
    for (const bad of ["4,10", "41,00.00", "4.100,00", "4 100", "4100.505", "1,2345", "abc", "-5", "4,100.00 dollars", "4100..5", "1e3"]) {
      const r = readTypedAmount(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.reason.length, bad).toBeGreaterThan(10);
    }
  });

  it("an empty box is refused as empty, not read as zero", () => {
    const r = readTypedAmount("   ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.empty).toBe(true);
  });

  it("the figure and the words come from the same number", () => {
    const r = readTypedAmount("4,100.00");
    expect(r.ok && amountInWords(r.amount)).toBe("Four Thousand One Hundred Dollars");
    expect(roundToCents(3632.75375)).toBe(3632.75);
    expect(roundToCents(0.1 + 0.2)).toBe(0.3);
  });
});

describe("unsaved changes", () => {
  it("two takeoffs with the same numbers are the same, whatever the key order", () => {
    const again = JSON.parse(JSON.stringify(base)) as CostInput;
    expect(sameJson(base, again)).toBe(true);
    expect(sameJson({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
  });

  it("any changed figure makes them differ", () => {
    expect(sameJson(base, { ...base, laborDays: 2 })).toBe(false);
    expect(sameJson(base, { ...base, sheetRows: sheets(36) })).toBe(false);
  });
});

describe("money", () => {
  it("writes an amount in words", () => {
    expect(amountInWords(24680.5)).toBe(
      "Twenty-Four Thousand Six Hundred Eighty Dollars and Fifty Cents",
    );
    expect(amountInWords(4100)).toBe("Four Thousand One Hundred Dollars");
    expect(amountInWords(1.01)).toBe("One Dollar and One Cent");
    expect(amountInWords(3632.75375)).toBe(
      "Three Thousand Six Hundred Thirty-Two Dollars and Seventy-Five Cents",
    );
  });
});
