/**
 * What the proposal says, worked out from the takeoff. Pure (no database, no
 * browser) so the same words are used by the server and the page, and so each
 * rule has a test in proposalRules.test.ts.
 */
import {
  amountInWords,
  type RoomRow,
  type SheetRow,
} from "./takeoffRules";

function firstValue(values: (string | null | undefined)[]): string | null {
  for (const v of values) {
    if (v && v.trim().length > 0) return v.trim();
  }
  return null;
}

const MOLDING_LABELS: Record<string, string> = {
  aluminum: "aluminum",
  pvc: "PVC",
};

/** The parts of a saved takeoff the proposal reads. */
export interface ProposalTakeoff {
  roomRows: RoomRow[];
  sheetRows: SheetRow[];
  thickness: string | null;
  totalPrice: number;
}

// Build the template FRP sentence from the takeoff (falling back to room
// specs for texture, which isn't captured on takeoff rows).
export function buildFrpSentence(
  takeoff: Pick<ProposalTakeoff, "roomRows" | "sheetRows" | "thickness">,
  textureFromSpecs: string | null,
): string {
  const rows = takeoff.roomRows;
  const thickness = firstValue([takeoff.thickness]) ?? "___";
  const fireRating =
    firstValue(rows.map((r) => r.fireRating))?.replace(/^class\s+/i, "") ??
    "___";
  const color = firstValue(rows.map((r) => r.color)) ?? "___";
  const texture = textureFromSpecs ?? "___";
  const moldingKey = rows.find((r) => r.moldingType)?.moldingType ?? null;
  const molding = moldingKey ? MOLDING_LABELS[moldingKey]! : "___";
  const totalSheets = takeoff.sheetRows.reduce(
    (sum, r) => sum + r.sheetsNeeded,
    0,
  );
  const sizes = [...new Set(takeoff.sheetRows
    .filter((r) => r.sheetsNeeded > 0)
    .map((r) => r.sheetSize))];
  const sheetSize = sizes.length > 0 ? sizes.join(" and ") : "___";
  return (
    `FRP ${thickness} thick class ${fireRating} in ${color} color, ` +
    `${texture} texture with ${molding} moldings. ` +
    `An allotment of ${totalSheets} ${sheetSize} sheets only.`
  );
}

export const STANDARD_NOTES = [
  "Price is based on a single trip to the job site.",
  "This is not a prevailing wage quote.",
  "Special-order materials will be billed upon receipt.",
  "Shop rate is $150.00 per hour per installer.",
  "A 3.5% fee applies to all credit card payments.",
  "Please provide schedules 3 weeks in advance.",
  "River City Plastics, Inc. is a non-union shop.",
  "We exclude wall surface preparation.",
].join("\n");

/** Every field a person can edit on the proposal. */
export interface ProposalFieldValues {
  proposalDate: string;
  projectName: string;
  projectAddress: string;
  projectCity: string;
  frp: string;
  highImpactWallPanel: string;
  cornerGuards: string;
  stainlessSteel: string;
  addsDeducts: string;
  exclusions: string;
  notes: string;
  priceAmount: number;
  priceInWords: string;
}

export interface ProposalSource {
  job: { jobName: string; address: string; city: string };
  takeoff: ProposalTakeoff;
  /** Texture from the room specs (takeoff rows do not carry it). */
  texture: string | null;
  now: Date;
  /** The proposal already stored for this job, if any. */
  existing: ProposalFieldValues | null;
}

/** The proposal fields written when "Generate" is pressed. */
export function buildProposalValues(src: ProposalSource): ProposalFieldValues {
  return {
    proposalDate: src.now.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    }),
    projectName: src.job.jobName,
    projectAddress: src.job.address,
    projectCity: src.job.city,
    frp: buildFrpSentence(src.takeoff, src.texture),
    highImpactWallPanel: "N/A",
    cornerGuards: "N/A",
    stainlessSteel: "N/A",
    addsDeducts: "N/A",
    exclusions: "",
    notes: STANDARD_NOTES,
    priceAmount: src.takeoff.totalPrice,
    priceInWords: amountInWords(src.takeoff.totalPrice),
  };
}
