/**
 * What the server itself decides about a takeoff and its proposal, tested
 * over HTTP against the real routes (signed in, as the page calls them).
 *
 * No database is used. The database client is replaced by a small stand-in
 * that holds ONE job's rows in memory and writes down every write, so a test
 * can say "nothing was stored".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signIn, startApp, type Reply, type Running } from "./test/harness";

type Row = Record<string, unknown>;

const memory = vi.hoisted(() => ({
  job: {} as Record<string, unknown>,
  takeoff: null as Record<string, unknown> | null,
  proposal: null as Record<string, unknown> | null,
  writes: [] as string[],
}));

vi.mock("@workspace/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@workspace/db")>();
  const rowsOf = (table: unknown): Row[] => {
    if (table === real.jobsTable) return [memory.job];
    if (table === real.takeoffsTable) return memory.takeoff ? [memory.takeoff] : [];
    if (table === real.proposalsTable) return memory.proposal ? [memory.proposal] : [];
    return []; // room specs: none
  };
  const write = (table: unknown, values: Row): Row[] => {
    if (table === real.takeoffsTable) {
      memory.writes.push("takeoffs");
      memory.takeoff = { ...memory.takeoff, ...values };
      return [memory.takeoff];
    }
    if (table === real.proposalsTable) {
      memory.writes.push("proposals");
      memory.proposal = { id: 1, ...memory.proposal, ...values };
      return [memory.proposal];
    }
    if (table === real.jobsTable) {
      memory.writes.push("jobs");
      memory.job = { ...memory.job, ...values };
      return [memory.job];
    }
    throw new Error("the stand-in database does not know this table");
  };
  const reading = (rows: Row[]) => {
    const step = {
      where: () => step,
      orderBy: () => step,
      then: (ok: (rows: Row[]) => unknown, bad?: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(ok, bad),
    };
    return step;
  };
  const db = {
    select: () => ({ from: (table: unknown) => reading(rowsOf(table)) }),
    insert: (table: unknown) => ({
      values: (values: Row) => ({
        onConflictDoUpdate: () => ({
          returning: () => Promise.resolve(write(table, values)),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: () => {
          const run = () => (rowsOf(table).length > 0 ? write(table, values) : []);
          return {
            returning: () => Promise.resolve(run()),
            then: (ok: (rows: Row[]) => unknown, bad?: (e: unknown) => unknown) =>
              Promise.resolve(run()).then(ok, bad),
          };
        },
      }),
    }),
  };
  return { ...real, db };
});

let running: Running;
let cookie: string;

beforeAll(async () => {
  running = await startApp();
  cookie = await signIn(running);
});

afterAll(async () => {
  await running.close();
});

beforeEach(() => {
  memory.job = {
    id: 1,
    jobName: "Stale price check (made up)",
    address: "3 Check St",
    city: "Checkville",
    status: "proposal_ready",
  };
  memory.takeoff = null;
  memory.proposal = null;
  memory.writes.length = 0;
});

const send = (method: string, path: string, body?: unknown): Promise<Reply> =>
  running.call(method, `/api/jobs/1${path}`, {
    cookie,
    headers: { origin: running.origin },
    ...(body === undefined ? {} : { body }),
  });

const room = (over: Row): Row => ({
  roomName: null,
  roomNumber: null,
  wallLengths: "",
  materialHeight: null,
  ceilingHeight: null,
  manufacturer: "Made-up Co",
  color: "White",
  productCode: "FRP-1",
  fireRating: "Class C",
  moldingType: "aluminum",
  ...over,
});
const kitchen = room({ roomName: "Kitchen", roomNumber: "101", wallLengths: "12 + 12 + 10", materialHeight: "8'-0\"", ceilingHeight: "9'-0\"" });
const restroom = (ceiling: string) =>
  room({ roomName: "Restroom", roomNumber: "103", wallLengths: "6 + 6 + 5'-6\" + 5'-6\"", ceilingHeight: ceiling });

/** The checker's takeoff: 9 x 4x8 and 6 x 4x10, priced: $3,799.00. */
const takeoff = (over: Row = {}): Row => ({
  roomRows: [kitchen, restroom("10'-0\"")],
  sheetRows: [
    { sheetsNeeded: 9, sheetSize: "4x8", pricePerSheet: 45.5, sheetsSource: "suggested" },
    { sheetsNeeded: 6, sheetSize: "4x10", pricePerSheet: 58.25, sheetsSource: "suggested" },
  ],
  priceSheetFileId: null,
  laborRate: 65,
  laborDays: 2,
  laborHoursPerDay: 8,
  travelMiles: 0,
  hotelNights: 0,
  freight: 0,
  profitOverride: null,
  totalPrice: 0,
  notes: null,
  thickness: ".090",
  ...over,
});
/** The restroom ceiling at 11 ft: a suggested 6 x 4x12 row with no price. */
const tallerUnpriced = takeoff({
  roomRows: [kitchen, restroom("11'-0\"")],
  sheetRows: [
    { sheetsNeeded: 9, sheetSize: "4x8", pricePerSheet: 45.5, sheetsSource: "suggested" },
    { sheetsNeeded: 0, sheetSize: "4x10", pricePerSheet: 58.25, sheetsSource: "suggested" },
    { sheetsNeeded: 6, sheetSize: "4x12", pricePerSheet: 0, sheetsSource: "suggested" },
  ],
});

describe("the server decides the price on a regenerate", () => {
  it("clears the old price when the saved takeoff gives none (the checker's scenario)", async () => {
    const saved = await send("PUT", "/takeoff", takeoff());
    expect(saved.status).toBe(200);
    expect(saved.json?.totalPrice).toBe(3799);
    const first = await send("POST", "/proposal/generate");
    expect(first.status).toBe(200);
    expect(first.json?.priceAmount).toBe(3799);
    expect(first.json?.frp).toContain("An allotment of 9 4x8 and 6 4x10 sheets only.");

    const savedAgain = await send("PUT", "/takeoff", tallerUnpriced);
    expect(savedAgain.status).toBe(200);
    expect(savedAgain.json?.totalPrice).toBe(0);

    // Sent by hand, with the old price in the request: the server does not take it.
    const again = await send("POST", "/proposal/generate", {
      priceAmount: 3799,
      priceInWords: "Three Thousand Seven Hundred Ninety-Nine Dollars",
    });
    expect(again.status).toBe(200);
    expect(again.json?.frp).toContain("An allotment of 9 4x8 and 6 4x12 sheets only.");
    expect(again.json?.priceAmount).toBe(0);
    expect(again.json?.priceInWords).toBe("");
    // and that is what is stored and read back
    expect(memory.proposal?.priceAmount).toBe(0);
    expect(memory.proposal?.priceInWords).toBe("");
    const read = await send("GET", "/proposal");
    expect(read.json?.priceAmount).toBe(0);
  });

  it("clears a price that was typed into the proposal too, and keeps the other text", async () => {
    await send("PUT", "/takeoff", tallerUnpriced);
    await send("POST", "/proposal/generate");
    const typed = await send("PATCH", "/proposal", { priceAmount: 4100, exclusions: "Demolition of existing wall finish." });
    expect(typed.json?.priceAmount).toBe(4100);
    expect(typed.json?.priceInWords).toBe("Four Thousand One Hundred Dollars");
    const again = await send("POST", "/proposal/generate");
    expect(again.json?.priceAmount).toBe(0);
    expect(again.json?.priceInWords).toBe("");
    expect(again.json?.exclusions).toBe("Demolition of existing wall finish.");
  });

  it("when the takeoff gives a price, the proposal takes it to the cent, as before", async () => {
    await send("PUT", "/takeoff", takeoff());
    await send("POST", "/proposal/generate");
    await send("PATCH", "/proposal", { priceAmount: 4100 });
    const again = await send("POST", "/proposal/generate");
    expect(again.json?.priceAmount).toBe(3799);
    expect(again.json?.priceInWords).toBe("Three Thousand Seven Hundred Ninety-Nine Dollars");
  });
});

describe("a sheet count is a whole number of 0 or more: the server refuses anything else", () => {
  const withCount = (count: unknown) =>
    takeoff({
      sheetRows: [
        { sheetsNeeded: 10, sheetSize: "4x8", pricePerSheet: 45.5, sheetsSource: "typed" },
        { sheetsNeeded: count, sheetSize: "4x10", pricePerSheet: 58.25, sheetsSource: "typed" },
      ],
    });

  it.each([
    [-5, "-5"],
    [8.5, "8.5"],
    ["1e3", '"1e3"'],
    ["abc", '"abc"'],
  ])("refuses %j in words and stores nothing", async (count, shown) => {
    await send("PUT", "/takeoff", takeoff());
    const before = JSON.stringify(memory.takeoff);
    memory.writes.length = 0;

    const reply = await send("PUT", "/takeoff", withCount(count));
    expect(reply.status).toBe(400);
    expect(reply.json?.message).toBe(
      `The takeoff was not saved. Sheet row 2: the sheet count must be a whole number of 0 or more (it is ${shown}).`,
    );
    expect(memory.writes).toEqual([]);
    expect(JSON.stringify(memory.takeoff)).toBe(before);
  });

  it("refuses it on a first save too: no takeoff is created", async () => {
    const reply = await send("PUT", "/takeoff", takeoff({ sheetRows: [{ sheetsNeeded: 8.5, sheetSize: "4x8", pricePerSheet: 45.5 }] }));
    expect(reply.status).toBe(400);
    expect(String(reply.json?.message)).toMatch(/^The takeoff was not saved\. Sheet row 1: the sheet count/);
    expect(memory.takeoff).toBeNull();
  });

  it("stores whole counts exactly as sent, old-shape rows included", async () => {
    const old = takeoff({ sheetRows: [{ sheetsNeeded: 18, sheetSize: "4x8", pricePerSheet: 45.5 }] });
    const reply = await send("PUT", "/takeoff", old);
    expect(reply.status).toBe(200);
    expect(reply.json?.sheetRows).toEqual([{ sheetsNeeded: 18, sheetSize: "4x8", pricePerSheet: 45.5 }]);
    expect(memory.writes).toEqual(["takeoffs"]);
    // a count of 0 is a count
    expect((await send("PUT", "/takeoff", withCount(0))).status).toBe(200);
  });
});

describe("no negative money or quantity is stored", () => {
  const pricedRow = { sheetsNeeded: 10, sheetSize: "4x8", pricePerSheet: 45.5, sheetsSource: "typed" };

  it.each([
    [{ freight: -1460 }, "Freight cannot be below 0 (it is -1460)."],
    [{ laborRate: -65 }, "The labor rate cannot be below 0 (it is -65)."],
    [{ laborDays: -2 }, "The labor days cannot be below 0 (it is -2)."],
    [{ laborHoursPerDay: -8 }, "The labor hours a day cannot be below 0 (it is -8)."],
    [{ travelMiles: -40 }, "The travel miles cannot be below 0 (it is -40)."],
    [{ hotelNights: -1 }, "The hotel nights cannot be below 0 (it is -1)."],
    [{ profitOverride: -100 }, "Profit cannot be below 0 (it is -100)."],
    [{ sheetRows: [{ ...pricedRow, pricePerSheet: -45.5 }] }, "Sheet row 1: the price per sheet cannot be below 0 (it is -45.5)."],
    [{ sheetRows: [{ ...pricedRow, moldingCount: -3 }] }, "Sheet row 1: the molding count cannot be below 0 (it is -3)."],
  ])("a takeoff with %j is refused in words and nothing is stored", async (over, words) => {
    await send("PUT", "/takeoff", takeoff());
    const before = JSON.stringify(memory.takeoff);
    memory.writes.length = 0;

    const reply = await send("PUT", "/takeoff", takeoff(over));
    expect(reply.status).toBe(400);
    expect(reply.json?.message).toBe(`The takeoff was not saved. ${words}`);
    expect(memory.writes).toEqual([]);
    expect(JSON.stringify(memory.takeoff)).toBe(before);
  });

  it("a proposal price below 0 is refused in words: it is not stored, and not turned into 0", async () => {
    await send("PUT", "/takeoff", takeoff());
    await send("POST", "/proposal/generate");
    memory.writes.length = 0;

    const reply = await send("PATCH", "/proposal", { priceAmount: -5, exclusions: "sent with the bad price" });
    expect(reply.status).toBe(400);
    expect(reply.json?.message).toBe(
      "The proposal was not saved. The price cannot be below 0. Type the total price, or leave the box empty for no price yet.",
    );
    expect(memory.writes).toEqual([]);
    expect(memory.proposal?.priceAmount).toBe(3799);
    expect(memory.proposal?.exclusions).toBe("");
  });

  it("an empty box is still no price: 0 is stored as 'not priced', with no words", async () => {
    // a takeoff with a sheet price left empty (0) is saved, and has no total
    const saved = await send("PUT", "/takeoff", takeoff({ sheetRows: [{ ...pricedRow, pricePerSheet: 0 }] }));
    expect(saved.status).toBe(200);
    expect(saved.json?.totalPrice).toBe(0);
    // a proposal whose price box was emptied is saved with no price and no words
    // Repair 3: this takeoff's rows are not what its walls need, so the
    // proposal needs his confirmation (not what this test is about). Repair 4:
    // the confirmation is the fingerprint of the list he was shown.
    const stop = await send("POST", "/proposal/generate");
    await send("POST", "/proposal/generate", { confirmCounts: stop.json?.fingerprint });
    await send("PATCH", "/proposal", { priceAmount: 4100 });
    const emptied = await send("PATCH", "/proposal", { priceAmount: 0 });
    expect(emptied.status).toBe(200);
    expect(emptied.json?.priceAmount).toBe(0);
    expect(emptied.json?.priceInWords).toBe("");
  });
});

describe("repair 3: suggested rows follow the walls, and a proposal asks before printing other counts", () => {
  it("a stale suggested row beside his typed row is brought up to the walls on save (BLOCKER-3)", async () => {
    const reply = await send(
      "PUT",
      "/takeoff",
      takeoff({
        sheetRows: [
          { sheetsNeeded: 3, sheetSize: "4x8", pricePerSheet: 45.5, sheetsSource: "suggested", rules: 3 },
          { sheetsNeeded: 6, sheetSize: "4x10", pricePerSheet: 58.25, sheetsSource: "typed" },
        ],
      }),
    );
    expect(reply.status).toBe(200);
    const rows = memory.takeoff?.sheetRows as Row[];
    expect(rows[0]).toMatchObject({ sheetsNeeded: 9, sheetsSource: "suggested" });
    expect(rows[1]).toEqual({ sheetsNeeded: 6, sheetSize: "4x10", pricePerSheet: 58.25, sheetsSource: "typed" });
  });

  it("rows that differ from the walls: refused in words until he confirms, for that request only (MAJOR-R3)", async () => {
    const extra = { sheetsNeeded: 12, sheetSize: "4x12", pricePerSheet: 50, sheetsSource: "typed" };
    await send("PUT", "/takeoff", takeoff({ sheetRows: [...(takeoff().sheetRows as Row[]), extra] }));
    const refused = await send("POST", "/proposal/generate");
    expect(refused.status).toBe(409);
    expect(refused.json?.code).toBe("counts_differ");
    expect(refused.json?.differences).toEqual(["4x12: the walls need 0, your rows hold 12"]);
    expect(memory.proposal).toBeNull();

    // Repair 4: he confirms the list he was shown (its fingerprint)
    const made = await send("POST", "/proposal/generate", { confirmCounts: refused.json?.fingerprint });
    expect(made.status).toBe(200);
    expect(made.json?.frp).toContain("An allotment of 9 4x8, 6 4x10 and 12 4x12 sheets only.");

    const again = await send("POST", "/proposal/generate");
    expect(again.status).toBe(409); // the confirmation is not remembered
  });

  it("rows that match the walls generate with no extra step", async () => {
    await send("PUT", "/takeoff", takeoff());
    const made = await send("POST", "/proposal/generate");
    expect(made.status).toBe(200);
  });
});

describe("repair 4: the stop checks only measured walls, and a confirmation covers only what he saw", () => {
  it("a job typed by hand with no wall lengths makes its proposal with no stop (MAJOR-R4-1)", async () => {
    await send("PUT", "/takeoff", takeoff({
      roomRows: [room({ roomName: "Kitchen", roomNumber: "101", materialHeight: "8'-0\"" })],
      sheetRows: [{ sheetsNeeded: 12, sheetSize: "4x8", pricePerSheet: 45.5, sheetsSource: "typed" }],
    }));
    const made = await send("POST", "/proposal/generate");
    expect(made.status).toBe(200);
    expect(made.json?.frp).toContain("An allotment of 12 4x8 sheets only.");
  });

  it("two people: Mike saves 20 x 4x12 between Ryan's stop and his confirm; Ryan is stopped again with the new list (MAJOR-R4-2)", async () => {
    const ryanRows = [
      { sheetsNeeded: 9, sheetSize: "4x8", pricePerSheet: 45.5, sheetsSource: "suggested" },
      { sheetsNeeded: 7, sheetSize: "4x10", pricePerSheet: 58.25, sheetsSource: "typed" },
    ];
    await send("PUT", "/takeoff", takeoff({ sheetRows: ryanRows }));
    const ryanStop = await send("POST", "/proposal/generate");
    expect(ryanStop.status).toBe(409);
    expect(ryanStop.json?.differences).toEqual(["4x10: the walls need 6, your rows hold 7"]);
    const seen = ryanStop.json?.fingerprint as string;
    expect(typeof seen).toBe("string");

    // Mike saves the same job with an extra 20 x 4x12
    await send("PUT", "/takeoff", takeoff({
      sheetRows: [...ryanRows, { sheetsNeeded: 20, sheetSize: "4x12", pricePerSheet: 50, sheetsSource: "typed" }],
    }));

    // Ryan presses "Make the proposal with these rows" with what he saw
    const again = await send("POST", "/proposal/generate", { confirmCounts: seen });
    expect(again.status).toBe(409);
    expect(again.json?.code).toBe("counts_differ");
    expect(again.json?.changed).toBe(true);
    expect(again.json?.differences).toEqual([
      "4x10: the walls need 6, your rows hold 7",
      "4x12: the walls need 0, your rows hold 20",
    ]);
    expect(memory.proposal).toBeNull();

    // confirming the list he now sees makes it
    const made = await send("POST", "/proposal/generate", { confirmCounts: again.json?.fingerprint });
    expect(made.status).toBe(200);
    expect(made.json?.frp).toContain("An allotment of 9 4x8, 7 4x10 and 20 4x12 sheets only.");
  });

  it("a blanket yes is not a confirmation", async () => {
    await send("PUT", "/takeoff", takeoff({
      sheetRows: [{ sheetsNeeded: 9, sheetSize: "4x8", pricePerSheet: 45.5, sheetsSource: "typed" }],
    }));
    const reply = await send("POST", "/proposal/generate", { confirmCounts: true });
    expect(reply.status).toBe(409);
    expect(memory.proposal).toBeNull();
  });
});
