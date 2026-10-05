/**
 * What the proposal says, worked out from the takeoff. Pure (no database, no
 * browser) so the same words are used by the server and the page, and so each
 * rule has a test in proposalRules.test.ts.
 */
import {
  amountInWords,
  computeCosts,
  readTypedAmount,
  roomLabel,
  roundToCents,
  type CostInput,
  type RoomRow,
  type SheetRow,
  type SheetSize,
} from "./takeoffRules";
import { dollars } from "./materialList";

function clean(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  return text.length > 0 ? text : null;
}

const MOLDING_LABELS: Record<string, string> = {
  aluminum: "aluminum",
  pvc: "PVC",
};

const BLANK = "___";

/** The parts of a saved takeoff the proposal reads. */
export interface ProposalTakeoff extends CostInput {
  roomRows: RoomRow[];
  sheetRows: SheetRow[];
  thickness: string | null;
}

/** Texture is kept on the room specs, not on the takeoff rows. */
export interface RoomTexture {
  roomName: string | null;
  roomNumber: string | null;
  texture: string | null;
}

// ---------------------------------------------------------------------------
// The FRP line
// ---------------------------------------------------------------------------

function joinWithAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function textureFor(
  row: RoomRow,
  textures: RoomTexture[],
  onlyTexture: string | null,
): string | null {
  const num = clean(row.roomNumber)?.toLowerCase() ?? null;
  const name = clean(row.roomName)?.toLowerCase() ?? null;
  const match =
    (num
      ? textures.find((t) => clean(t.roomNumber)?.toLowerCase() === num)
      : undefined) ??
    (name
      ? textures.find((t) => clean(t.roomName)?.toLowerCase() === name)
      : undefined);
  return clean(match?.texture) ?? onlyTexture;
}

interface PanelGroup {
  rooms: string[];
  fire: string | null;
  color: string | null;
  texture: string | null;
  molding: string | null;
}

const FIELDS = ["fire", "color", "texture", "molding"] as const;

/** An empty box is "not said", never "different". */
function agrees(a: string | null, b: string | null): boolean {
  return a === null || b === null || a.toLowerCase() === b.toLowerCase();
}

/** Rooms in room order, put together when their panels do not differ. */
function groupRooms(rows: RoomRow[], textures: RoomTexture[]): PanelGroup[] {
  const distinct = [
    ...new Set(
      textures
        .map((t) => clean(t.texture))
        .filter((t): t is string => t !== null)
        .map((t) => t.toLowerCase()),
    ),
  ];
  const onlyTexture =
    distinct.length === 1
      ? clean(textures.find((t) => clean(t.texture))?.texture)
      : null;

  const groups: PanelGroup[] = [];
  rows.forEach((row, index) => {
    const said =
      clean(row.roomName) ??
      clean(row.roomNumber) ??
      clean(row.wallLengths) ??
      clean(row.color) ??
      clean(row.fireRating) ??
      row.moldingType;
    if (!said) return; // an untouched empty row is not a room
    const room = {
      fire: clean(row.fireRating)?.replace(/^class\s+/i, "") ?? null,
      color: clean(row.color),
      texture: textureFor(row, textures, onlyTexture),
      molding: row.moldingType ? MOLDING_LABELS[row.moldingType]! : null,
    };
    const home = groups.find((g) => FIELDS.every((f) => agrees(g[f], room[f])));
    if (home) {
      home.rooms.push(roomLabel(row, index));
      for (const f of FIELDS) home[f] ??= room[f];
    } else {
      groups.push({ rooms: [roomLabel(row, index)], ...room });
    }
  });
  return groups;
}

function describePanels(g: PanelGroup | undefined): string {
  return (
    `class ${g?.fire ?? BLANK} in ${g?.color ?? BLANK} color, ` +
    `${g?.texture ?? BLANK} texture with ${g?.molding ?? BLANK} moldings.`
  );
}

/** "12 4x8 and 6 4x10": a count for each sheet size that has sheets. */
export function sheetAllotment(sheetRows: SheetRow[]): {
  total: number;
  bySize: { size: SheetSize; count: number }[];
  phrase: string;
} {
  const bySize: { size: SheetSize; count: number }[] = [];
  for (const row of sheetRows) {
    if (!(row.sheetsNeeded > 0)) continue;
    const found = bySize.find((s) => s.size === row.sheetSize);
    if (found) found.count += row.sheetsNeeded;
    else bySize.push({ size: row.sheetSize, count: row.sheetsNeeded });
  }
  const total = bySize.reduce((sum, s) => sum + s.count, 0);
  const phrase =
    bySize.length > 0
      ? joinWithAnd(bySize.map((s) => `${s.count} ${s.size}`))
      : `0 ${BLANK}`;
  return { total, bySize, phrase };
}

/**
 * The FRP line of the proposal, from the takeoff as it is.
 *
 * It covers every room. Rooms whose panels do not differ share one
 * description (so a one-product job reads exactly as the template always
 * did); rooms that differ are each named, in room order. Anything the takeoff
 * does not say is left as a visible blank (___), never guessed.
 */
export function buildFrpSentence(
  takeoff: Pick<ProposalTakeoff, "roomRows" | "sheetRows" | "thickness">,
  textures: RoomTexture[],
): string {
  const thickness = clean(takeoff.thickness) ?? BLANK;
  const groups = groupRooms(takeoff.roomRows, textures);
  const allotment = `An allotment of ${sheetAllotment(takeoff.sheetRows).phrase} sheets only.`;
  if (groups.length <= 1) {
    return `FRP ${thickness} thick ${describePanels(groups[0])} ${allotment}`;
  }
  const perGroup = groups
    .map((g) => `${joinWithAnd(g.rooms)}: ${describePanels(g)}`)
    .join(" ");
  return `FRP ${thickness} thick. ${perGroup} ${allotment}`;
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

// ---------------------------------------------------------------------------
// Making and regenerating the proposal
// ---------------------------------------------------------------------------

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
  /** The takeoff as it is saved now. */
  takeoff: ProposalTakeoff;
  /** Texture per room, from the room specs. */
  textures: RoomTexture[];
  now: Date;
  /** The proposal already stored for this job, if any. */
  existing: ProposalFieldValues | null;
}

/**
 * The price a takeoff gives, to the cent, and its words (same number). Null
 * when the takeoff is not fully priced: a part-total is never a price.
 */
export function priceFromTakeoff(takeoff: ProposalTakeoff): {
  priceAmount: number;
  priceInWords: string;
} | null {
  const costs = computeCosts(takeoff);
  if (!costs.fullyPriced) return null;
  const priceAmount = roundToCents(costs.total);
  return { priceAmount, priceInWords: amountInWords(priceAmount) };
}

/**
 * The proposal fields written when "Generate" or "Regenerate" is pressed.
 *
 * Two things come from the takeoff every time: the FRP line and the price
 * (worked out from the takeoff's own figures, never from a stored total).
 * Everything else is written once, the first time. On a regenerate, whatever
 * is already in the proposal stays exactly as the person left it: date,
 * project lines, the other product lines, adds/deducts, exclusions, notes.
 *
 * Prices are optional. When the takeoff is not fully priced it gives no
 * price, and then the proposal has none either: a new proposal starts with
 * none, and a regenerate CLEARS the price the proposal had. That price was
 * set for the sheet counts the proposal had before; the FRP line is rewritten
 * with the counts as they are now, and new counts must never go out under a
 * price that was set for other counts. The person types the total again
 * (the export is refused until then).
 */
export function buildProposalValues(src: ProposalSource): ProposalFieldValues {
  const fromTakeoff = {
    frp: buildFrpSentence(src.takeoff, src.textures),
    ...(priceFromTakeoff(src.takeoff) ?? { priceAmount: 0, priceInWords: "" }),
  };
  if (src.existing) {
    return {
      proposalDate: src.existing.proposalDate,
      projectName: src.existing.projectName,
      projectAddress: src.existing.projectAddress,
      projectCity: src.existing.projectCity,
      highImpactWallPanel: src.existing.highImpactWallPanel,
      cornerGuards: src.existing.cornerGuards,
      stainlessSteel: src.existing.stainlessSteel,
      addsDeducts: src.existing.addsDeducts,
      exclusions: src.existing.exclusions,
      notes: src.existing.notes,
      ...fromTakeoff,
    };
  }
  return {
    // The shop's own calendar day (Rocklin, CA), whatever clock the server keeps.
    proposalDate: src.now.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "America/Los_Angeles",
    }),
    projectName: src.job.jobName,
    projectAddress: src.job.address,
    projectCity: src.job.city,
    highImpactWallPanel: "N/A",
    cornerGuards: "N/A",
    stainlessSteel: "N/A",
    addsDeducts: "N/A",
    exclusions: "",
    notes: STANDARD_NOTES,
    ...fromTakeoff,
  };
}

/**
 * What a Regenerate does to the price when the takeoff gives none, said
 * BEFORE it happens (the "Regenerate?" window shows these words, with the
 * figure that will go).
 */
export function noPriceRegenerateWarning(
  currentPrice: number,
  notPriced: string[],
): string {
  const why =
    notPriced.length > 0
      ? `The takeoff has no price yet for ${notPriced.join(", ")}.`
      : "The takeoff has no price.";
  return currentPrice > 0
    ? `${why} This proposal's price (${dollars(currentPrice)}) will be cleared: type it again after you check it.`
    : `${why} This proposal has no price either: type the total in the Price box.`;
}

/** The same, said AFTER the server answered with no price. */
export function noPriceRegenerateResult(previousPrice: number): string {
  return previousPrice > 0
    ? `The takeoff has no price, so this proposal's price (${dollars(previousPrice)}) was cleared. Check it, then type the total in the Price box.`
    : "The takeoff has no full price, so the price was not taken from it. Type the total in the Price box.";
}

/**
 * A notice for the proposal, never a block: the saved takeoff is fully priced
 * and its total is not the price the proposal says (he may have typed his
 * own price on purpose, or the takeoff may have moved since). Null when
 * there is nothing to say: the takeoff gives no price, or the two agree to
 * within half a cent.
 */
export function priceDifferenceNotice(
  takeoffPrice: number | null,
  proposalPrice: number,
): string | null {
  if (takeoffPrice === null) return null;
  if (Math.abs(takeoffPrice - proposalPrice) <= 0.005) return null;
  return proposalPrice > 0
    ? `The takeoff now adds up to ${dollars(takeoffPrice)}. This proposal says ${dollars(proposalPrice)}.`
    : `The takeoff now adds up to ${dollars(takeoffPrice)}. This proposal has no price yet.`;
}

/** Why a price sent to the server cannot be stored, in words. Null = fine. */
export function priceProblem(priceAmount: number): string | null {
  return Number.isFinite(priceAmount) && priceAmount >= 0
    ? null
    : "The price cannot be below 0. Type the total price, or leave the box empty for no price yet.";
}

// ---------------------------------------------------------------------------
// Before a proposal goes out
// ---------------------------------------------------------------------------

export interface ExportCheck {
  /** The price as one number, or null when it cannot be printed. */
  amount: number | null;
  /** The words for that same number ("" when there is no number). */
  words: string;
  /** Why the proposal cannot be exported yet, in plain words. Empty = fine. */
  problems: string[];
}

/**
 * Checks the proposal on screen before it is saved or printed. The figure and
 * the words always come from the one number read here.
 */
export function checkProposalForExport(fields: {
  frp: string;
  priceAmount: string;
}): ExportCheck {
  const problems: string[] = [];
  let amount: number | null = null;
  const read = readTypedAmount(fields.priceAmount);
  if (!read.ok) {
    problems.push(
      read.empty
        ? "There is no price. Type the total price before you export."
        : `The price is not clear. ${read.reason}`,
    );
  } else if (read.amount <= 0) {
    problems.push("The price is $0.00. Type the total price before you export.");
  } else {
    amount = read.amount;
  }
  if (/_{3,}/.test(fields.frp)) {
    problems.push(
      "The FRP line still has a blank marked ___. Fill it in (or complete the takeoff and regenerate) before you export.",
    );
  }
  return {
    amount,
    words: amount === null ? "" : amountInWords(amount),
    problems,
  };
}
