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

describe("money", () => {
  it("reads a plain typed amount", () => {
    expect(readTypedAmount("4100.50")).toBe(4100.5);
  });

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
