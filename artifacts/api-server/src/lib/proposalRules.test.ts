/**
 * Tests for what the proposal says. Pure: no database, no network.
 */
import { describe, it, expect } from "vitest";
import {
  buildFrpSentence,
  buildProposalValues,
  checkProposalForExport,
  STANDARD_NOTES,
  type ProposalFieldValues,
  type ProposalTakeoff,
  type RoomTexture,
} from "./proposalRules";
import type { RoomRow } from "./takeoffRules";

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

  it("refuses while the FRP line still has a blank marked ___", () => {
    const r = checkProposalForExport(fields({ frp: "FRP ___ thick class C" }));
    expect(r.problems.join(" ")).toMatch(/___/);
  });
});
