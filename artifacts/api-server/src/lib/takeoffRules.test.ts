/**
 * Tests for the takeoff rules. Pure: no database, no network.
 */
import { describe, it, expect } from "vitest";
import {
  PROFIT_FLAT_MAX_SHEETS,
  amountInWords,
  checkTakeoffNumbers,
  computeCosts,
  flatProfitApplies,
  linearFootage,
  parseWallLengths,
  readSheetCount,
  readTypedAmount,
  resolvePricePerSheet,
  roundToCents,
  sameJson,
  screenMayTakeSavedCopy,
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

  it("his rule: flat profit is for 8 and under, so exactly 8 sheets is flat", () => {
    expect(flatProfitApplies(8)).toBe(true);
    expect(computeCosts({ ...base, sheetRows: sheets(8), laborDays: 2 }).autoProfit).toBe(800);
    expect(PROFIT_FLAT_MAX_SHEETS).toBe(8);
  });

  it("the ninth sheet moves the job to $1,000 a labor day", () => {
    const eight = computeCosts({ ...base, sheetRows: sheets(8), laborDays: 2 });
    const nine = computeCosts({ ...base, sheetRows: sheets(9), laborDays: 2 });
    expect(eight.profit).toBe(800);
    expect(nine.profit).toBe(2000);
    // one more sheet at $45.50, and $1,200 more profit
    expect(nine.total - eight.total).toBe(45.5 + 1200);
  });

  it("counts sheets across every row, whatever the size", () => {
    const rows: SheetRow[] = [
      { sheetsNeeded: 5, sheetSize: "4x8", pricePerSheet: 45.5 },
      { sheetsNeeded: 3, sheetSize: "4x10", pricePerSheet: 58.25 },
    ];
    expect(computeCosts({ ...base, sheetRows: rows }).autoProfit).toBe(800);
    rows[1]!.sheetsNeeded = 4;
    expect(computeCosts({ ...base, sheetRows: rows }).autoProfit).toBe(1250);
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

describe("a sheet count is a whole number of 0 or more", () => {
  it("reads whole numbers typed into the box", () => {
    expect(readSheetCount("12")).toEqual({ ok: true, count: 12 });
    expect(readSheetCount(" 7 ")).toEqual({ ok: true, count: 7 });
    expect(readSheetCount("0")).toEqual({ ok: true, count: 0 });
    // an emptied box is no sheets, as before
    expect(readSheetCount("")).toEqual({ ok: true, count: 0 });
  });

  it("refuses -5, 8.5, 1e3 and words, in words, and guesses nothing", () => {
    for (const typed of ["-5", "8.5", "1e3", "abc", "12 sheets", "1,000", "+4", "８"]) {
      const read = readSheetCount(typed);
      expect(read.ok, typed).toBe(false);
      expect(read).toMatchObject({
        reason: `Can't use "${typed}" as a sheet count. Type a whole number of 0 or more, like 12.`,
      });
    }
  });

  const row = (sheetsNeeded: unknown) => ({ sheetsNeeded, sheetSize: "4x8", pricePerSheet: 45.5 });

  it("the server's check passes whole counts, and a takeoff stored before the update", () => {
    expect(checkTakeoffNumbers(base)).toEqual([]);
    expect(checkTakeoffNumbers({ ...base, sheetRows: [row(18)] })).toEqual([]);
    expect(checkTakeoffNumbers({ ...base, sheetRows: [row(0)] })).toEqual([]);
    expect(checkTakeoffNumbers({ ...base, sheetRows: [] })).toEqual([]);
    // 1e3 sent as a JSON number IS the whole number 1000
    expect(checkTakeoffNumbers(JSON.parse('{"sheetRows":[{"sheetsNeeded":1e3}]}'))).toEqual([]);
  });

  it("the server's check refuses a count that is not a whole number of 0 or more, naming the row", () => {
    expect(checkTakeoffNumbers({ ...base, sheetRows: [row(10), row(-5)] })).toEqual([
      "Sheet row 2: the sheet count must be a whole number of 0 or more (it is -5).",
    ]);
    expect(checkTakeoffNumbers({ ...base, sheetRows: [row(8.5)] })).toEqual([
      "Sheet row 1: the sheet count must be a whole number of 0 or more (it is 8.5).",
    ]);
    expect(checkTakeoffNumbers({ ...base, sheetRows: [row("1e3")] })).toEqual([
      'Sheet row 1: the sheet count must be a whole number of 0 or more (it is "1e3").',
    ]);
    expect(checkTakeoffNumbers({ ...base, sheetRows: [row("abc"), row(null), {}] })).toEqual([
      'Sheet row 1: the sheet count must be a whole number of 0 or more (it is "abc").',
      "Sheet row 2: the sheet count must be a whole number of 0 or more (it is null).",
      "Sheet row 3: the sheet count must be a whole number of 0 or more (it is missing).",
    ]);
    // a number too big to be a count at all (1e999 reads as Infinity)
    expect(checkTakeoffNumbers(JSON.parse('{"sheetRows":[{"sheetsNeeded":1e999}]}'))).toHaveLength(1);
  });

  it("has nothing to say about a body that is not a takeoff (the usual check answers that)", () => {
    expect(checkTakeoffNumbers(undefined)).toEqual([]);
    expect(checkTakeoffNumbers("text")).toEqual([]);
    expect(checkTakeoffNumbers({ sheetRows: "none" })).toEqual([]);
  });
});

describe("typing while a save is on its way", () => {
  // A stand-in for the takeoff page: what is on screen (as typed), the copy
  // the server stored, and a Save whose answer is held back until asked for.
  type Screen = { wall: string; thickness: string; laborDays: string; sheets: number };
  function page(start: Screen) {
    let screen = start;
    let stored = start;
    return {
      type(patch: Partial<Screen>) {
        screen = { ...screen, ...patch };
      },
      pressSave() {
        const shownWhenSent = screen;
        return {
          sent: shownWhenSent,
          // the server's answer arrives: its own copy of what was sent
          answerArrives(fromServer: Screen) {
            if (screenMayTakeSavedCopy(shownWhenSent, screen)) screen = fromServer;
            stored = fromServer;
          },
        };
      },
      get screen() {
        return screen;
      },
      get says() {
        return sameJson(stored, screen) ? "Saved" : "Changes not saved";
      },
    };
  }
  const start: Screen = { wall: "12 + 12 + 10", thickness: "", laborDays: "2", sheets: 25 };

  it("keeps what was typed after Save was pressed, and does not say Saved over it", () => {
    // the checker's run: thickness typed, Save pressed, a wall typed while the answer was held 2 s
    const p = page(start);
    p.type({ thickness: ".125" });
    const save = p.pressSave();
    p.type({ wall: "12 + 12 + 10 + 40", sheets: 35 });
    save.answerArrives(save.sent);
    expect(p.screen.wall).toBe("12 + 12 + 10 + 40");
    expect(p.screen.sheets).toBe(35);
    expect(p.says).toBe("Changes not saved");
    // pressing Save again, with nothing typed in between, saves it
    const second = p.pressSave();
    second.answerArrives(second.sent);
    expect(p.screen.wall).toBe("12 + 12 + 10 + 40");
    expect(p.says).toBe("Saved");
  });

  it("the plain case is as before: nothing typed in between, the screen takes the server's rows and total", () => {
    const p = page(start);
    p.type({ thickness: ".125" });
    const save = p.pressSave();
    // the server brings a suggested count up to date before it stores it
    save.answerArrives({ ...save.sent, sheets: 9 });
    expect(p.screen).toEqual({ wall: "12 + 12 + 10", thickness: ".125", laborDays: "2", sheets: 9 });
    expect(p.says).toBe("Saved");
  });

  it("something typed and put back is not a change", () => {
    const p = page(start);
    const save = p.pressSave();
    p.type({ wall: "12 + 12 + 10 + 4" });
    p.type({ wall: "12 + 12 + 10" });
    save.answerArrives({ ...save.sent, sheets: 9 });
    expect(p.screen.sheets).toBe(9);
  });

  it("a number still being typed (2 then 2.) is typing: the box is not put back to 2", () => {
    const p = page(start);
    const save = p.pressSave();
    p.type({ laborDays: "2." });
    save.answerArrives(save.sent);
    expect(p.screen.laborDays).toBe("2.");
  });

  it("compares what the screen shows, not the order of the keys", () => {
    expect(screenMayTakeSavedCopy({ a: "1", rows: [{ n: 1, s: "4x8" }] }, { rows: [{ s: "4x8", n: 1 }], a: "1" })).toBe(true);
    expect(screenMayTakeSavedCopy({ a: "1" }, { a: "1 " })).toBe(false);
    expect(screenMayTakeSavedCopy({ rows: [1, 2] }, { rows: [1, 2, 3] })).toBe(false);
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
