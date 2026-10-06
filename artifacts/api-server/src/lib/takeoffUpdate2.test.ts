/**
 * Update 2: the client's own rules for rounding, short panels, tall walls and
 * moldings (his answers of 2026-10-06). Each case below is one of his own
 * examples or a rule from the job file. Pure: no database, no network.
 *
 * His words, as he wrote them:
 * 1. "Molding counts are based off of a few factors. Sheet height, 4' tall
 *    material needs cap on top and bottom (a full stick each) one divider, and
 *    inside/outside corners as needed based off plans. taller than 4' is the
 *    same except cap is 1 stick for top and bottom rather than two."
 * 2. "Taller than 12' is tricky, we can stack FRP to any height but it varies
 *    what length is used to get to the desired height depending on the rest of
 *    the job. For example if the restr of the job is 8' we would start with an
 *    8 then stack 8s to reach the desired height. if we have 10s on the job but
 *    need to hit 14' then it would be a 10' vertical and an 8' horizontal."
 * 3. "for 4' tall we put the 4x8 on its side but for products like marlite
 *    symetrix it comes in a 4x4 panel. to my knowledge that is the only panel
 *    type that comes in a 4x4."
 * 4. "im a little confused by this. we take each wall and round to the nearest
 *    foot. if its a 7 foot wall we round to 8 feet and if the wall is 3 feet we
 *    round to 4 feet. at the end we round the total sheet count up to the next
 *    full sheet"
 */
import { describe, it, expect } from "vitest";
import {
  CURRENT_RULES,
  WALL_ROUND_UP_TO_FT,
  applySuggestions,
  checkTakeoffNumbers,
  moldingsByKind,
  refreshSuggestedRows,
  roundWallUp,
  savedTotalPrice,
  setKindCount,
  suggestRoom,
  suggestSheets,
  suggestStack,
  tidyMoldingCounts,
  type RoomRow,
  type SheetRow,
} from "./takeoffRules";
import { buildMaterialList, materialListHtml } from "./materialList";

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

const line = (m: ReturnType<typeof moldingsByKind>, key: string) =>
  m.lines.find((l) => l.key === key);

// ---------------------------------------------------------------------------
// 1. Rounding, his way (answer 4)
// ---------------------------------------------------------------------------
describe("each wall is rounded up before anything is added (answer 4)", () => {
  it("his examples: a 7 ft wall counts as 8 ft, a 3 ft wall as 4 ft", () => {
    expect(roundWallUp(7)).toBe(8);
    expect(roundWallUp(3)).toBe(4);
  });

  // Repair 1 (the desk's ruling: walls up to the next even foot): the constant is 2 now; both readings keep a test.
  it("the open point lives in ONE constant, set to the next even foot until he answers", () => {
    expect(WALL_ROUND_UP_TO_FT).toBe(2);
  });

  it("a 5 ft wall: 8 ft when walls go up to the next 4 ft (the other reading)", () => {
    expect(roundWallUp(5, 4)).toBe(8);
    expect(roundWallUp(5)).toBe(6); // the reading built
  });

  it("a 5 ft wall: 6 ft when walls go up to the next even foot (the other reading)", () => {
    expect(roundWallUp(5, 2)).toBe(6);
    // his own two examples fit this reading too
    expect(roundWallUp(7, 2)).toBe(8);
    expect(roundWallUp(3, 2)).toBe(4);
  });

  it("a wall already on the step stays as it is; inches go up to the step", () => {
    expect(roundWallUp(8)).toBe(8);
    expect(roundWallUp(12)).toBe(12);
    expect(roundWallUp(7.5)).toBe(8);
    // Repair 1 (the desk's ruling: walls up to the next even foot): 8 ft 1 in counts as 10 ft (12 ft at the next 4 ft)
    expect(roundWallUp(8 + 1 / 12)).toBe(10);
    expect(roundWallUp(8 + 1 / 12, 4)).toBe(12);
  });

  it("rounds each wall, then adds them, and shows the working per wall", () => {
    const s = suggestRoom(room({ wallLengths: "7 + 3 + 12", materialHeight: "8'" }));
    expect(s.walls.map((w) => [w.typedFt, w.countedFt])).toEqual([
      [7, 8],
      [3, 4],
      [12, 12],
    ]);
    expect(s.countedFeet).toBe(24);
    expect(s.wallWorking).toBe("7 ft counted as 8 ft + 3 ft counted as 4 ft + 12 ft = 24 ft");
    expect(s.sheets).toBe(6);
    expect(s.arithmetic).toBe("24 ft ÷ 4 ft a sheet = 6 sheets of 4x8");
  });

  it("a room of 7 + 3 + 5 ft: 20 ft with the 4 ft reading, 18 ft with the even-foot reading", () => {
    // Repair 1 (the desk's ruling: walls up to the next even foot): the default is now the even-foot reading
    expect(suggestRoom(room({ wallLengths: "7 + 3 + 5", materialHeight: "8" }), { rounding: 4 }).countedFeet).toBe(20);
    expect(suggestRoom(room({ wallLengths: "7 + 3 + 5", materialHeight: "8" })).countedFeet).toBe(18);
  });

  it("rounds the job's sheet count up once per sheet size, at the end", () => {
    // Two 4 ft rooms of 12 ft each: 1.5 + 1.5 sheets of 4x8 on its side = 3, not 4.
    const job = suggestSheets([
      room({ roomName: "Hall", wallLengths: "12", materialHeight: "4'" }),
      room({ roomName: "Bar", wallLengths: "12", materialHeight: "4'" }),
    ]);
    expect(job.rooms.map((r) => r.sheets)).toEqual([1.5, 1.5]);
    expect(job.bySize["4x8"]).toBe(3);
    expect(job.sizeWorking["4x8"]).toBe("4x8: 1.5 + 1.5 = 3 sheets");
    // one such room on its own is 1.5, rounded up to 2
    const one = suggestSheets([room({ wallLengths: "12", materialHeight: "4'" })]);
    expect(one.bySize["4x8"]).toBe(2);
    expect(one.sizeWorking["4x8"]).toBe("4x8: 1.5, rounded up to 2 sheets");
  });
});

// ---------------------------------------------------------------------------
// 2. A panel 4 ft tall or less (answer 3)
// ---------------------------------------------------------------------------
describe("a panel 4 ft tall: the 4x8 goes on its side (answer 3)", () => {
  it("one 4x8 on its side covers 8 ft of wall", () => {
    const s = suggestRoom(room({ wallLengths: "8 + 8 + 8 + 8", materialHeight: "4'" }));
    expect(s.layout).toBe("onSide");
    expect(s.sheets).toBe(4);
    expect(s.sheetSize).toBe("4x8");
    expect(s.arithmetic).toBe("32 ft ÷ 8 ft a sheet (4x8 on its side) = 4 sheets of 4x8");
    expect(s.warning).toBeNull(); // the old "may be about half" warning is gone: the count is right
  });

  it("48 inches and 3'-8\" are 4 ft or less too", () => {
    expect(suggestRoom(room({ wallLengths: "16", materialHeight: '48"' })).sheets).toBe(2);
    expect(suggestRoom(room({ wallLengths: "16", materialHeight: "3'-8\"" })).layout).toBe("onSide");
  });

  it("just over 4 ft is an upright sheet, one per 4 ft", () => {
    const s = suggestRoom(room({ wallLengths: "16", materialHeight: "4'-1\"" }));
    expect(s.layout).toBe("upright");
    expect(s.sheets).toBe(4);
  });

  it("a 4x4 product (he names Marlite Symetrix): one 4x4 panel per 4 ft of wall", () => {
    const s = suggestRoom(
      room({ wallLengths: "16", materialHeight: "4'", manufacturer: "Marlite", productCode: "Symetrix" }),
    );
    expect(s.layout).toBe("fourByFour");
    expect(s.sheetSize).toBe("4x4");
    expect(s.sheets).toBe(4);
    expect(s.fourByFour).toMatchObject({ on: true, source: "product" });
    expect(s.assumed.join(" ")).toMatch(/assumed/);
    expect(s.arithmetic).toBe("16 ft ÷ 4 ft a panel = 4 panels of 4x4");
  });

  it("he can tick 4x4 by hand, or untick a product match", () => {
    const ticked = suggestRoom(room({ wallLengths: "16", materialHeight: "4'", fourByFour: true }));
    expect(ticked).toMatchObject({ layout: "fourByFour", sheets: 4, sheetSize: "4x4" });
    expect(ticked.fourByFour.source).toBe("ticked");
    expect(ticked.assumed).toEqual([]);
    const unticked = suggestRoom(
      room({ wallLengths: "16", materialHeight: "4'", productCode: "Symetrix", fourByFour: false }),
    );
    expect(unticked).toMatchObject({ layout: "onSide", sheets: 2, sheetSize: "4x8" });
  });

  it("4x4 panels go on the 4x4 sheet row", () => {
    const job = suggestSheets([room({ wallLengths: "16", materialHeight: "4'", fourByFour: true })]);
    expect(job.bySize).toEqual({ "4x4": 4, "4x8": 0, "4x10": 0, "4x12": 0 });
  });

  it("a 4x4 ticked on a panel taller than 4 ft is asked about, not guessed", () => {
    const s = suggestRoom(room({ wallLengths: "16", materialHeight: "8'", fourByFour: true }));
    expect(s.sheets).toBeNull();
    expect(s.problem).toMatch(/4x4/);
  });
});

// ---------------------------------------------------------------------------
// 3. Moldings by kind (answer 1)
// ---------------------------------------------------------------------------
describe("moldings by kind (answer 1)", () => {
  it("4 ft material: 2 caps a sheet and 1 divider a sheet, 8 ft molding", () => {
    const rooms = [room({ wallLengths: "8 + 8 + 8 + 8", materialHeight: "4'" })]; // 4 sheets on their side
    const m = moldingsByKind(rooms, applySuggestions([], rooms, []));
    expect(line(m, "cap-8")).toMatchObject({ suggested: 8, count: 8, typed: false });
    expect(line(m, "divider-8")).toMatchObject({ suggested: 4, count: 4 });
  });

  it("taller than 4 ft: 1 cap a sheet, 1 divider a sheet", () => {
    const rooms = [room({ wallLengths: "8 + 8 + 8 + 8", materialHeight: "8'" })]; // 8 sheets upright
    const m = moldingsByKind(rooms, applySuggestions([], rooms, []));
    expect(line(m, "cap-8")).toMatchObject({ suggested: 8 });
    expect(line(m, "divider-8")).toMatchObject({ suggested: 8 });
  });

  it("the molding length follows the sheet height: 8 ft molding for 8 ft and under, 10 ft above", () => {
    const rooms = [room({ wallLengths: "40", materialHeight: "10'" })]; // 10 x 4x10
    const m = moldingsByKind(rooms, applySuggestions([], rooms, []));
    expect(line(m, "cap-10")).toMatchObject({ lengthFt: 10, suggested: 10 });
    expect(line(m, "divider-10")).toMatchObject({ lengthFt: 10, suggested: 10 });
    expect(line(m, "cap-8")).toBeUndefined();
  });

  it("shows its working", () => {
    const rooms = [
      room({ roomName: "Bar", wallLengths: "12", materialHeight: "4'" }), // 1.5 on side
      room({ roomName: "Kitchen", wallLengths: "32", materialHeight: "8'" }), // 8 upright
    ];
    const m = moldingsByKind(rooms, applySuggestions([], rooms, []));
    expect(line(m, "cap-8")!.working).toBe(
      "2 a sheet × 1.5 sheets 4 ft tall + 1 a sheet × 8 sheets taller than 4 ft = 11",
    );
    expect(line(m, "divider-8")!.working).toBe("1 a sheet × 9.5 sheets = 9.5, rounded up to 10");
  });

  it("corners come from his two boxes per room only, never guessed", () => {
    const none = [room({ wallLengths: "32", materialHeight: "8'" })];
    const m0 = moldingsByKind(none, applySuggestions([], none, []));
    expect(line(m0, "insideCorner-8")).toBeUndefined();
    expect(line(m0, "outsideCorner-8")).toBeUndefined();

    const rooms = [
      room({ roomName: "Kitchen", wallLengths: "32", materialHeight: "8'", insideCorners: 4, outsideCorners: 2 }),
      room({ roomName: "Prep", roomNumber: "102", wallLengths: "40", materialHeight: "10'", insideCorners: 3 }),
      room({ roomName: "Bar", roomNumber: "103", wallLengths: "16", materialHeight: "4'", insideCorners: 1 }),
    ];
    const m = moldingsByKind(rooms, applySuggestions([], rooms, []));
    expect(line(m, "insideCorner-8")).toMatchObject({ suggested: 5, count: 5 });
    expect(line(m, "insideCorner-8")!.working).toBe("typed per room: Kitchen 101 4 + Bar 103 1 = 5");
    expect(line(m, "outsideCorner-8")).toMatchObject({ suggested: 2 });
    expect(line(m, "insideCorner-10")).toMatchObject({ suggested: 3 });
    expect(line(m, "outsideCorner-10")).toBeUndefined();
  });

  it("a count he types over stays his, and clearing it goes back to the rule", () => {
    const rooms = [room({ wallLengths: "32", materialHeight: "8'" })];
    const rows = setKindCount(applySuggestions([], rooms, []), "cap-8", 12);
    const m = moldingsByKind(rooms, rows);
    expect(line(m, "cap-8")).toMatchObject({ suggested: 8, count: 12, typed: true });
    // the walls change: his count stays
    const longer = [room({ wallLengths: "48", materialHeight: "8'" })];
    const after = tidyMoldingCounts(applySuggestions(rooms, longer, rows));
    expect(line(moldingsByKind(longer, after), "cap-8")).toMatchObject({ suggested: 12, count: 12, typed: true });
    const cleared = setKindCount(after, "cap-8", null);
    expect(line(moldingsByKind(longer, cleared), "cap-8")).toMatchObject({ count: 12, typed: false });
    expect(cleared.some((r) => "moldingCounts" in r)).toBe(false); // no trace left
  });

  it("a typed zero is a count, and every sheet row carries the same typed counts", () => {
    const rooms = [
      room({ wallLengths: "32", materialHeight: "8'" }),
      room({ wallLengths: "40", materialHeight: "10'" }),
    ];
    const rows = setKindCount(applySuggestions([], rooms, []), "divider-10", 0);
    expect(line(moldingsByKind(rooms, rows), "divider-10")).toMatchObject({ count: 0, typed: true });
    expect(rows.every((r) => r.moldingCounts?.["divider-10"] === 0)).toBe(true);
  });

  it("does not invent: 12 ft sheets and stacked walls are listed as not counted", () => {
    const rooms = [
      room({ roomName: "Wash", wallLengths: "20", materialHeight: "12'", insideCorners: 2 }),
      room({ roomName: "Kitchen", wallLengths: "32", materialHeight: "10'" }),
      room({ roomName: "Cooler", wallLengths: "20", materialHeight: "14'" }),
    ];
    const m = moldingsByKind(rooms, applySuggestions([], rooms, []));
    expect(m.notCounted.join(" ")).toMatch(/Wash 101.*12 ft sheet/);
    expect(m.notCounted.join(" ")).toMatch(/Cooler 101.*stack/);
    // only the 10 ft room is in the counts
    expect(line(m, "cap-10")).toMatchObject({ suggested: 8 });
    expect(line(m, "insideCorner-10")).toBeUndefined();
  });

  it("4x4 panels: caps and dividers counted like other 4 ft material, and marked assumed", () => {
    const rooms = [room({ wallLengths: "16", materialHeight: "4'", fourByFour: true })];
    const m = moldingsByKind(rooms, applySuggestions([], rooms, []));
    expect(line(m, "cap-8")).toMatchObject({ suggested: 8 });
    expect(line(m, "divider-8")).toMatchObject({ suggested: 4 });
    expect(line(m, "cap-8")!.assumed.join(" ")).toMatch(/4x4.*assumed/);
  });
});

// ---------------------------------------------------------------------------
// 4. Taller than 12 ft: a suggested stack (answer 2)
// ---------------------------------------------------------------------------
describe("taller than 12 ft: a suggested stack, never a silent count (answer 2)", () => {
  it("his example: 10s on the job and 14 ft to reach -> a 10 upright and an 8 on its side", () => {
    expect(suggestStack(14, 10)).toEqual([10, 4]);
    const job = suggestSheets([
      room({ roomName: "Kitchen", wallLengths: "40", materialHeight: "10'" }),
      room({ roomName: "Cooler", roomNumber: "104", wallLengths: "16", materialHeight: "14'" }),
    ]);
    const cooler = job.rooms[1]!;
    expect(cooler.layout).toBe("stack");
    expect(cooler.stack).toMatchObject({ courses: [10, 4], typed: false });
    expect(cooler.stack!.note).toMatch(/your call: change it if you would stack it differently/);
    expect(cooler.parts.map((p) => [p.size, p.onSide, p.sheets])).toEqual([
      ["4x10", false, 4],
      ["4x8", true, 2],
    ]);
    expect(job.bySize).toEqual({ "4x4": 0, "4x8": 2, "4x10": 14, "4x12": 0 });
  });

  it("his example: 8s on the job -> start with an 8 then stack 8s", () => {
    expect(suggestStack(14, 8)).toEqual([8, 8]);
    expect(suggestStack(16, 8)).toEqual([8, 8]);
    expect(suggestStack(18, 8)).toEqual([8, 8, 4]);
    const job = suggestSheets([
      room({ roomName: "Kitchen", wallLengths: "32", materialHeight: "8'" }),
      room({ roomName: "Cooler", wallLengths: "16", materialHeight: "14'" }),
    ]);
    expect(job.rooms[1]!.stack!.courses).toEqual([8, 8]);
    expect(job.bySize["4x8"]).toBe(8 + 4 + 4);
  });

  it("a tall wall on a job with no other sheet size asks, it does not guess", () => {
    const job = suggestSheets([room({ roomName: "Cooler", wallLengths: "16", materialHeight: "14'" })]);
    const s = job.rooms[0]!;
    expect(s.sheets).toBeNull();
    expect(s.problem).toMatch(/no other sheet size/);
    expect(job.bySize).toEqual({ "4x4": 0, "4x8": 0, "4x10": 0, "4x12": 0 });
  });

  it("he can set the courses by hand, and they are checked against the height", () => {
    const rooms = [
      room({ roomName: "Kitchen", wallLengths: "40", materialHeight: "10'" }),
      room({ roomName: "Cooler", wallLengths: "16", materialHeight: "14'", stackCourses: "8 + 8" }),
    ];
    const s = suggestSheets(rooms).rooms[1]!;
    expect(s.stack).toMatchObject({ courses: [8, 8], typed: true });
    expect(s.parts.map((p) => [p.size, p.onSide, p.sheets])).toEqual([
      ["4x8", false, 4],
      ["4x8", false, 4],
    ]);
    const short = suggestSheets([rooms[0]!, { ...rooms[1]!, stackCourses: "10" }]).rooms[1]!;
    expect(short.sheets).toBeNull();
    expect(short.problem).toMatch(/reach 10 ft.*14 ft/);
    const bad = suggestSheets([rooms[0]!, { ...rooms[1]!, stackCourses: "16" }]).rooms[1]!;
    expect(bad.problem).toMatch(/16/);
  });

  it("exactly 12 ft is one 4x12, not a stack", () => {
    expect(suggestRoom(room({ wallLengths: "16", materialHeight: "12'" }))).toMatchObject({
      layout: "upright",
      sheetSize: "4x12",
      sheets: 4,
      stack: null,
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Old takeoffs open with the numbers they were saved with
// ---------------------------------------------------------------------------
describe("a takeoff saved before this update", () => {
  // Saved by update 1: one suggested row under the old rule (each room
  // rounded on its own: 28 ft -> 7), one row he typed, and a typed molding count.
  const oldRooms: RoomRow[] = [
    room({ roomName: "Kitchen", wallLengths: "7 + 7 + 7 + 7", materialHeight: "8'" }),
    room({ roomName: "Prep", wallLengths: "10 + 10 + 10 + 10", materialHeight: "9'" }),
  ];
  const oldRows: SheetRow[] = [
    { sheetsNeeded: 7, sheetSize: "4x8", pricePerSheet: 45.5, sheetsSource: "suggested" },
    { sheetsNeeded: 12, sheetSize: "4x10", pricePerSheet: 58.25, sheetsSource: "typed", moldingCount: 22 },
  ];
  const costs = {
    laborRate: 65,
    laborDays: 2,
    laborHoursPerDay: 8,
    travelMiles: 0,
    hotelNights: 0,
    freight: 0,
    profitOverride: null,
  };

  it("keeps its saved counts when the server refreshes it (save and proposal)", () => {
    // the new rules alone would make the 4x8 row 8 (each 7 ft wall counted as 8 ft)
    expect(suggestSheets(oldRooms).bySize["4x8"]).toBe(8);
    expect(refreshSuggestedRows(oldRooms, oldRows)).toEqual(oldRows);
    expect(savedTotalPrice({ sheetRows: refreshSuggestedRows(oldRooms, oldRows), ...costs })).toBe(
      savedTotalPrice({ sheetRows: oldRows, ...costs }),
    );
  });

  it("a wall change does not move a row suggested under the earlier rules", () => {
    const longer = oldRooms.map((r, i) => (i === 0 ? { ...r, wallLengths: "7 + 7 + 7 + 7 + 7" } : r));
    const after = applySuggestions(oldRooms, longer, oldRows);
    expect(after).toEqual(oldRows);
  });

  it("the new rules would suggest a different count, and the job says so", () => {
    const list = buildMaterialList({
      jobName: "Old job",
      address: "",
      city: "",
      date: "October 6, 2026",
      thickness: null,
      roomRows: oldRooms,
      sheetRows: oldRows,
    });
    const s48 = list.sheets.find((s) => s.size === "4x8")!;
    expect(s48).toMatchObject({ count: 7, whose: "earlier", suggested: 8 });
    expect(list.assumptions.join(" ")).toMatch(/4x8: 7 sheets.*earlier rules.*new rules suggest 8/);
  });

  it("his typed molding count from before is kept and used for that length", () => {
    const m = moldingsByKind(oldRooms, oldRows);
    expect(m.legacy).toEqual([{ lengthFt: 10, count: 22 }]);
    const list = buildMaterialList({
      jobName: "Old job",
      address: "",
      city: "",
      date: "October 6, 2026",
      thickness: null,
      roomRows: oldRooms,
      sheetRows: oldRows,
    });
    expect(list.moldings.filter((l) => l.lengthFt === 10)).toEqual([]);
    expect(list.legacyMoldings).toEqual([{ lengthFt: 10, count: 22 }]);
    expect(materialListHtml(list)).toMatch(/10 ft molding, all kinds/);
  });

  it("new suggested rows are marked with the rules they were made under", () => {
    // Repair 1: the rules mark moved on with the rounding change (MAJOR-1)
    expect(CURRENT_RULES).toBe(3);
    const rows = applySuggestions([], oldRooms, []);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.rules === CURRENT_RULES)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The Material list and the numbers the server accepts
// ---------------------------------------------------------------------------
describe("the Material list shows each molding kind, length and count", () => {
  it("lists caps, dividers and corners with their lengths, and says what is assumed", () => {
    const rooms = [
      room({ roomName: "Bar", wallLengths: "7 + 3", materialHeight: "4'", insideCorners: 1 }),
      room({ roomName: "Kitchen", wallLengths: "32", materialHeight: "8'", outsideCorners: 2 }),
      room({ roomName: "Prep", wallLengths: "40", materialHeight: "10'" }),
    ];
    const list = buildMaterialList({
      jobName: "Test",
      address: "",
      city: "",
      date: "October 6, 2026",
      thickness: null,
      roomRows: rooms,
      sheetRows: applySuggestions([], rooms, []),
    });
    expect(list.moldings.map((m) => `${m.kind} ${m.lengthFt} ${m.count}`)).toEqual([
      "cap 8 11",
      "divider 8 10",
      "insideCorner 8 1",
      "outsideCorner 8 2",
      "cap 10 10",
      "divider 10 10",
    ]);
    const html = materialListHtml(list);
    expect(html).toMatch(/Cap<\/td><td>8 ft/);
    expect(html).toMatch(/Inside corner<\/td><td>8 ft/);
    // Repair 1 (the desk's ruling: walls up to the next even foot): the words name the even foot, still ASSUMED
    expect(list.assumptions.join(" ")).toMatch(/next even foot.*ASSUMED/);
    expect(list.rooms[0]!.wallWorking).toBe("7 ft counted as 8 ft + 3 ft counted as 4 ft = 12 ft");
  });
});

describe("numbers a room may hold", () => {
  it("refuses a corner count that is not a whole number of 0 or more, and a molding count below 0", () => {
    const bad = {
      roomRows: [room({ insideCorners: -1 }), room({ outsideCorners: 1.5 })],
      sheetRows: [{ sheetsNeeded: 1, sheetSize: "4x8", pricePerSheet: 0, moldingCounts: { "cap-8": -2 } }],
    };
    const problems = checkTakeoffNumbers(bad);
    expect(problems.join(" ")).toMatch(/Room 1.*inside corners/);
    expect(problems.join(" ")).toMatch(/Room 2.*outside corners/);
    expect(problems.join(" ")).toMatch(/Sheet row 1.*cap/);
    expect(checkTakeoffNumbers({ roomRows: [room({ insideCorners: 3, outsideCorners: null })], sheetRows: [] })).toEqual([]);
  });
});
