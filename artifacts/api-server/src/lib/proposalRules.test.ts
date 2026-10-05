/**
 * Tests for what the proposal says. Pure: no database, no network.
 */
import { describe, it, expect } from "vitest";
import {
  buildFrpSentence,
  buildProposalValues,
  STANDARD_NOTES,
  type ProposalTakeoff,
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

const takeoff = (over: Partial<ProposalTakeoff> = {}): ProposalTakeoff => ({
  roomRows: [room()],
  sheetRows: [{ sheetsNeeded: 18, sheetSize: "4x8", pricePerSheet: 45.5 }],
  thickness: ".090",
  totalPrice: 3632.75,
  ...over,
});

const job = { jobName: "Taco Shop TI", address: "100 Main St", city: "Rocklin" };
const now = new Date(2026, 9, 5, 12, 0, 0);

describe("FRP sentence", () => {
  it("describes a one-product job in the template's words", () => {
    expect(buildFrpSentence(takeoff(), "Pebbled")).toBe(
      "FRP .090 thick class C in White color, Pebbled texture with aluminum moldings. " +
        "An allotment of 18 4x8 sheets only.",
    );
  });

  it("leaves a visible blank for anything the takeoff does not say", () => {
    const t = takeoff({
      thickness: null,
      roomRows: [room({ color: null, fireRating: null, moldingType: null })],
    });
    expect(buildFrpSentence(t, null)).toBe(
      "FRP ___ thick class ___ in ___ color, ___ texture with ___ moldings. " +
        "An allotment of 18 4x8 sheets only.",
    );
  });
});

describe("making the proposal", () => {
  it("fills the template from the job and the takeoff", () => {
    const p = buildProposalValues({ job, takeoff: takeoff(), texture: "Pebbled", now, existing: null });
    expect(p.proposalDate).toBe("October 5, 2026");
    expect(p.projectName).toBe("Taco Shop TI");
    expect(p.projectAddress).toBe("100 Main St");
    expect(p.projectCity).toBe("Rocklin");
    expect(p.notes).toBe(STANDARD_NOTES);
    expect(p.exclusions).toBe("");
    expect(p.priceAmount).toBe(3632.75);
    expect(p.priceInWords).toBe(
      "Three Thousand Six Hundred Thirty-Two Dollars and Seventy-Five Cents",
    );
  });
});
