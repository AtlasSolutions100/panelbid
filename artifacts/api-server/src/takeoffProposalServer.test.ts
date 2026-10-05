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
