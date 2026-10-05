/**
 * Tests for what the proposal says. Pure: no database, no network.
 */
import { describe, it, expect } from "vitest";
import {
  buildFrpSentence,
  buildProposalValues,
  checkProposalForExport,
  noPriceRegenerateResult,
  noPriceRegenerateWarning,
  priceFromTakeoff,
  priceProblem,
  STANDARD_NOTES,
  type ProposalFieldValues,
  type ProposalTakeoff,
  type RoomTexture,
} from "./proposalRules";
import { applySuggestions, type RoomRow } from "./takeoffRules";

const room = (over: Partial<RoomRow> = {}): RoomRow => ({
  roomName: "Kitchen",
  roomNumber: "101",
  wallLengths: "12 + 12 + 10 + 10",
  materialHeight: "8'-0\"",
  manufacturer: "Marlite",
  color: "White",
  productCode: "FRP-1",
  fireRating: "Class C",
  moldingType: "aluminum",
  ...over,
});

const restroom = (over: Partial<RoomRow> = {}): RoomRow =>
  room({
    roomName: "Restroom",
    roomNumber: "102",
    color: "Almond",
    fireRating: "Class A",
    moldingType: "pvc",
    ...over,
  });

const takeoff = (over: Partial<ProposalTakeoff> = {}): ProposalTakeoff => ({
  roomRows: [room()],
  sheetRows: [{ sheetsNeeded: 18, sheetSize: "4x8", pricePerSheet: 45.5 }],
  thickness: ".090",
  laborRate: 65,
  laborDays: 1.25,
  laborHoursPerDay: 10.25,
  travelMiles: 40,
  hotelNights: 1,
  freight: 150,
  profitOverride: null,
  ...over,
});

const pebbled: RoomTexture[] = [
  { roomName: "Kitchen", roomNumber: "101", texture: "Pebbled" },
];
const twoTextures: RoomTexture[] = [
  { roomName: "Kitchen", roomNumber: "101", texture: "Pebbled" },
  { roomName: "Restroom", roomNumber: "102", texture: "Smooth" },
];

const job = { jobName: "Taco Shop TI", address: "100 Main St", city: "Rocklin" };
const now = new Date("2026-10-05T19:00:00Z"); // noon in Rocklin, CA

describe("FRP sentence", () => {
  it("describes a one-product job in the template's words", () => {
    expect(buildFrpSentence(takeoff(), pebbled)).toBe(
      "FRP .090 thick class C in White color, Pebbled texture with aluminum moldings. " +
        "An allotment of 18 4x8 sheets only.",
    );
  });

  it("leaves a visible blank for anything the takeoff does not say", () => {
    const t = takeoff({
      thickness: null,
      roomRows: [room({ color: null, fireRating: null, moldingType: null })],
    });
    expect(buildFrpSentence(t, [])).toBe(
      "FRP ___ thick class ___ in ___ color, ___ texture with ___ moldings. " +
        "An allotment of 18 4x8 sheets only.",
    );
  });

  it("names every room when the rooms get different panels, in room order", () => {
    const t = takeoff({
      roomRows: [room(), restroom()],
      sheetRows: [
        { sheetsNeeded: 12, sheetSize: "4x8", pricePerSheet: 45.5 },
        { sheetsNeeded: 6, sheetSize: "4x10", pricePerSheet: 58.25 },
      ],
    });
    expect(buildFrpSentence(t, twoTextures)).toBe(
      "FRP .090 thick. " +
        "Kitchen 101: class C in White color, Pebbled texture with aluminum moldings. " +
        "Restroom 102: class A in Almond color, Smooth texture with PVC moldings. " +
        "An allotment of 12 4x8 and 6 4x10 sheets only.",
    );
  });

  it("puts rooms with the same panels together and keeps the others apart", () => {
    const t = takeoff({
      roomRows: [
        room(),
        restroom(),
        room({ roomName: "Storage", roomNumber: "103" }),
      ],
    });
    const textures: RoomTexture[] = [
      ...twoTextures,
      { roomName: "Storage", roomNumber: "103", texture: "Pebbled" },
    ];
    expect(buildFrpSentence(t, textures)).toBe(
      "FRP .090 thick. " +
        "Kitchen 101 and Storage 103: class C in White color, Pebbled texture with aluminum moldings. " +
        "Restroom 102: class A in Almond color, Smooth texture with PVC moldings. " +
        "An allotment of 18 4x8 sheets only.",
    );
  });

  it("a room that only leaves a box empty is not a different product", () => {
    const t = takeoff({
      roomRows: [room(), room({ roomName: "Storage", roomNumber: "103", moldingType: null, color: null })],
    });
    expect(buildFrpSentence(t, pebbled)).toBe(
      "FRP .090 thick class C in White color, Pebbled texture with aluminum moldings. " +
        "An allotment of 18 4x8 sheets only.",
    );
  });

  it("gives a count for each sheet size", () => {
    const t = takeoff({
      sheetRows: [
        { sheetsNeeded: 12, sheetSize: "4x8", pricePerSheet: 0 },
        { sheetsNeeded: 4, sheetSize: "4x10", pricePerSheet: 0 },
        { sheetsNeeded: 5, sheetSize: "4x10", pricePerSheet: 0 },
        { sheetsNeeded: 0, sheetSize: "4x12", pricePerSheet: 0 },
      ],
    });
    expect(buildFrpSentence(t, pebbled)).toContain(
      "An allotment of 12 4x8 and 9 4x10 sheets only.",
    );
  });
});

describe("making the proposal", () => {
  it("fills the template from the job and the takeoff", () => {
    const p = buildProposalValues({ job, takeoff: takeoff(), textures: pebbled, now, existing: null });
    expect(p.proposalDate).toBe("October 5, 2026");
    expect(p.projectName).toBe("Taco Shop TI");
    expect(p.projectAddress).toBe("100 Main St");
    expect(p.projectCity).toBe("Rocklin");
    expect(p.notes).toBe(STANDARD_NOTES);
    expect(p.exclusions).toBe("");
    // 18 x 45.50 + 65 x 1.25 x 10.25 + 0.3125 h x 34 + 480 + 375 + 150 + 1,250
    expect(p.priceAmount).toBe(3917.44);
    expect(p.priceInWords).toBe(
      "Three Thousand Nine Hundred Seventeen Dollars and Forty-Four Cents",
    );
  });

  it("dates it by the shop's day in California, not the server's clock", () => {
    // 6:30 pm on October 5 in Rocklin is already October 6 on a UTC server.
    const evening = new Date("2026-10-06T01:30:00Z");
    const p = buildProposalValues({ job, takeoff: takeoff(), textures: pebbled, now: evening, existing: null });
    expect(p.proposalDate).toBe("October 5, 2026");
  });

  it("takes the price from the takeoff's own figures, never from a stored total", () => {
    const stale = { ...takeoff(), totalPrice: 3632.75 } as ProposalTakeoff;
    const p = buildProposalValues({ job, takeoff: stale, textures: pebbled, now, existing: null });
    expect(p.priceAmount).toBe(3917.44);
  });
});

describe("regenerating a proposal", () => {
  const first = buildProposalValues({ job, takeoff: takeoff(), textures: pebbled, now, existing: null });
  const typed: ProposalFieldValues = {
    ...first,
    proposalDate: "October 1, 2026",
    projectName: "Taco Shop - Tenant Improvement",
    projectAddress: "100 Main Street, Suite B",
    exclusions: "Demolition of existing wall finish.",
    addsDeducts: "Add $250 for stainless corner guards.",
    cornerGuards: "4 stainless corner guards, 4 ft",
    highImpactWallPanel: "None",
    stainlessSteel: "None",
    notes: STANDARD_NOTES + "\nNet 30.",
  };
  const bigger = takeoff({
    sheetRows: [{ sheetsNeeded: 36, sheetSize: "4x8", pricePerSheet: 45.5 }],
  });
  const again = buildProposalValues({ job, takeoff: bigger, textures: pebbled, now, existing: typed });

  it("keeps everything the person typed (the saved exclusion is not wiped)", () => {
    expect(again.exclusions).toBe("Demolition of existing wall finish.");
    expect(again.addsDeducts).toBe("Add $250 for stainless corner guards.");
    expect(again.cornerGuards).toBe("4 stainless corner guards, 4 ft");
    expect(again.highImpactWallPanel).toBe("None");
    expect(again.stainlessSteel).toBe("None");
    expect(again.notes).toBe(STANDARD_NOTES + "\nNet 30.");
    expect(again.proposalDate).toBe("October 1, 2026");
    expect(again.projectName).toBe("Taco Shop - Tenant Improvement");
    expect(again.projectAddress).toBe("100 Main Street, Suite B");
  });

  it("rewrites the FRP line and the price from the takeoff as it is now", () => {
    expect(again.frp).toContain("An allotment of 36 4x8 sheets only.");
    // 36 x 45.50 = 1,638.00 of material instead of 819.00
    expect(again.priceAmount).toBe(4736.44);
    expect(again.priceInWords).toBe(
      "Four Thousand Seven Hundred Thirty-Six Dollars and Forty-Four Cents",
    );
  });
});

describe("new sheet counts never go out under a price set for other counts", () => {
  // The checker's scenario: 9 x 4x8 and 6 x 4x10, priced, give $3,799.00.
  const rooms: RoomRow[] = [
    room({ wallLengths: "12 + 12 + 10", materialHeight: "8'-0\"" }),
    restroom({ wallLengths: "6 + 6 + 5'-6\" + 5'-6\"", materialHeight: null, ceilingHeight: "10'-0\"" }),
  ];
  const priced = takeoff({
    roomRows: rooms,
    sheetRows: [
      { sheetsNeeded: 9, sheetSize: "4x8", pricePerSheet: 45.5, sheetsSource: "suggested" },
      { sheetsNeeded: 6, sheetSize: "4x10", pricePerSheet: 58.25, sheetsSource: "suggested" },
    ],
    laborRate: 65,
    laborDays: 2,
    laborHoursPerDay: 8,
    travelMiles: 0,
    hotelNights: 0,
    freight: 0,
  });
  const first = buildProposalValues({ job, takeoff: priced, textures: twoTextures, now, existing: null });

  // The restroom ceiling goes to 11 ft: a suggested 6 x 4x12 row appears with
  // no price, so the takeoff reads "not priced". Saved, then regenerated.
  const taller = rooms.map((r, i) => (i === 1 ? { ...r, ceilingHeight: "11'-0\"" } : r));
  const unpriced = {
    ...priced,
    roomRows: taller,
    sheetRows: applySuggestions(rooms, taller, priced.sheetRows),
  };
  const again = buildProposalValues({ job, takeoff: unpriced, textures: twoTextures, now, existing: first });
  // What the page puts in the Price box for a stored price.
  const priceBox = (p: ProposalFieldValues) => (p.priceAmount > 0 ? p.priceAmount.toFixed(2) : "");

  it("starts from the priced proposal the checker had", () => {
    expect(first.frp).toContain("An allotment of 9 4x8 and 6 4x10 sheets only.");
    expect(first.priceAmount).toBe(3799);
    expect(first.priceInWords).toBe("Three Thousand Seven Hundred Ninety-Nine Dollars");
    expect(unpriced.sheetRows).toEqual([
      { sheetsNeeded: 9, sheetSize: "4x8", pricePerSheet: 45.5, sheetsSource: "suggested" },
      { sheetsNeeded: 0, sheetSize: "4x10", pricePerSheet: 58.25, sheetsSource: "suggested" },
      { sheetsNeeded: 6, sheetSize: "4x12", pricePerSheet: 0, sheetsSource: "suggested" },
    ]);
    expect(priceFromTakeoff(unpriced)).toBeNull();
  });

  it("a regenerate from a takeoff with no price clears the price: no old price under the new counts", () => {
    expect(again.frp).toContain("An allotment of 9 4x8 and 6 4x12 sheets only.");
    expect(again.priceAmount).toBe(0);
    expect(again.priceInWords).toBe("");
  });

  it("and the proposal cannot be exported until a price is typed again", () => {
    const check = checkProposalForExport({ frp: again.frp, priceAmount: priceBox(again) });
    expect(check.amount).toBeNull();
    expect(check.problems).toEqual(["There is no price. Type the total price before you export."]);
  });

  it("clears a price the person typed too: the server never keeps a price the takeoff does not give", () => {
    const typed: ProposalFieldValues = { ...first, priceAmount: 4100, priceInWords: "Four Thousand One Hundred Dollars" };
    const p = buildProposalValues({ job, takeoff: unpriced, textures: twoTextures, now, existing: typed });
    expect(p.priceAmount).toBe(0);
    expect(p.priceInWords).toBe("");
    // everything else he typed is still kept
    const kept = buildProposalValues({
      job,
      takeoff: unpriced,
      textures: twoTextures,
      now,
      existing: { ...typed, exclusions: "Demolition of existing wall finish." },
    });
    expect(kept.exclusions).toBe("Demolition of existing wall finish.");
  });

  it("when the takeoff gives a price nothing changes: the price is the takeoff's, to the cent", () => {
    const typed: ProposalFieldValues = { ...first, priceAmount: 4100, priceInWords: "Four Thousand One Hundred Dollars" };
    const p = buildProposalValues({ job, takeoff: priced, textures: twoTextures, now, existing: typed });
    expect(p.priceAmount).toBe(3799);
    expect(p.priceInWords).toBe("Three Thousand Seven Hundred Ninety-Nine Dollars");
    // and with the new row priced, the new counts get their own price
    const repriced = {
      ...unpriced,
      sheetRows: unpriced.sheetRows.map((r) => (r.sheetSize === "4x12" ? { ...r, pricePerSheet: 70 } : r)),
    };
    const q = buildProposalValues({ job, takeoff: repriced, textures: twoTextures, now, existing: again });
    expect(q.priceAmount).toBe(9 * 45.5 + 6 * 70 + 65 * 2 * 8 + 2000);
    expect(q.priceAmount).toBe(3869.5);
  });

  it("a first proposal from a takeoff with no price starts with no price, as before", () => {
    const p = buildProposalValues({ job, takeoff: unpriced, textures: twoTextures, now, existing: null });
    expect(p.priceAmount).toBe(0);
    expect(p.priceInWords).toBe("");
    expect(p.notes).toBe(STANDARD_NOTES);
  });

  it("says before a regenerate what happens to the price, with the figure", () => {
    const words = noPriceRegenerateWarning(3799, ["sheet prices (4x12)"]);
    expect(words).toBe(
      "The takeoff has no price yet for sheet prices (4x12). " +
        "This proposal's price ($3,799.00) will be cleared: type it again after you check it.",
    );
    expect(noPriceRegenerateWarning(0, ["labor"])).toBe(
      "The takeoff has no price yet for labor. This proposal has no price either: type the total in the Price box.",
    );
    expect(noPriceRegenerateResult(3799)).toMatch(/price \(\$3,799\.00\) was cleared/);
    // no sentence says the price stays, or that somebody typed it
    for (const s of [words, noPriceRegenerateWarning(0, []), noPriceRegenerateResult(3799), noPriceRegenerateResult(0)]) {
      expect(s).not.toMatch(/stays|as you typed/i);
    }
  });
});

describe("before a proposal is exported", () => {
  const ok = buildProposalValues({ job, takeoff: takeoff(), textures: pebbled, now, existing: null });
  const fields = (over: Record<string, string> = {}) => ({
    frp: ok.frp,
    priceAmount: "3,917.44",
    ...over,
  });

  it("passes a complete proposal and reads the typed price", () => {
    const r = checkProposalForExport(fields());
    expect(r.problems).toEqual([]);
    expect(r.amount).toBe(3917.44);
  });

  it("refuses a price it cannot read, in words", () => {
    const r = checkProposalForExport(fields({ priceAmount: "4,10" }));
    expect(r.amount).toBeNull();
    expect(r.problems.join(" ")).toMatch(/price/i);
  });

  it("refuses an empty or zero price", () => {
    expect(checkProposalForExport(fields({ priceAmount: "" })).problems.length).toBe(1);
    expect(checkProposalForExport(fields({ priceAmount: "0" })).problems.length).toBe(1);
  });

  it("a price below 0 is never stored: the server refuses it in words", () => {
    expect(priceProblem(-5)).toBe(
      "The price cannot be below 0. Type the total price, or leave the box empty for no price yet.",
    );
    expect(priceProblem(-0.01)).not.toBeNull();
    expect(priceProblem(0)).toBeNull(); // an empty box: no price yet
    expect(priceProblem(4100)).toBeNull();
  });

  it("refuses while the FRP line still has a blank marked ___", () => {
    const r = checkProposalForExport(fields({ frp: "FRP ___ thick class C" }));
    expect(r.problems.join(" ")).toMatch(/___/);
  });
});
