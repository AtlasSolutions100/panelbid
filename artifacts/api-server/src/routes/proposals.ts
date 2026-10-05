import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  jobsTable,
  takeoffsTable,
  proposalsTable,
  roomSpecsTable,
  type ProposalRow,
  type TakeoffRow,
} from "@workspace/db";
import {
  GetProposalParams,
  GetProposalResponse,
  UpdateProposalParams,
  UpdateProposalBody,
  UpdateProposalResponse,
  GenerateProposalParams,
  GenerateProposalResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const ONES = [
  "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight",
  "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen",
  "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const TENS = [
  "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy",
  "Eighty", "Ninety",
];
const SCALES = ["", " Thousand", " Million", " Billion"];

function threeDigitsToWords(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) parts.push(`${ONES[hundreds]} Hundred`);
  if (rest > 0) {
    if (rest < 20) {
      parts.push(ONES[rest]!);
    } else {
      const ten = TENS[Math.floor(rest / 10)]!;
      const one = rest % 10;
      parts.push(one > 0 ? `${ten}-${ONES[one]}` : ten);
    }
  }
  return parts.join(" ");
}

function integerToWords(n: number): string {
  if (n === 0) return "Zero";
  const groups: string[] = [];
  let remaining = n;
  let scale = 0;
  while (remaining > 0 && scale < SCALES.length) {
    const group = remaining % 1000;
    if (group > 0) {
      groups.unshift(`${threeDigitsToWords(group)}${SCALES[scale]}`);
    }
    remaining = Math.floor(remaining / 1000);
    scale += 1;
  }
  return groups.join(" ");
}

// e.g. 24680.5 -> "Twenty-Four Thousand Six Hundred Eighty Dollars and Fifty Cents"
export function amountInWords(amount: number): string {
  const safe = Math.max(0, Math.round(amount * 100));
  const dollars = Math.floor(safe / 100);
  const cents = safe % 100;
  const dollarWords = `${integerToWords(dollars)} Dollar${dollars === 1 ? "" : "s"}`;
  if (cents === 0) return dollarWords;
  return `${dollarWords} and ${integerToWords(cents)} Cent${cents === 1 ? "" : "s"}`;
}

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

// Build the template FRP sentence from the takeoff (falling back to room
// specs for texture, which isn't captured on takeoff rows).
export function buildFrpSentence(
  takeoff: TakeoffRow,
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

function serializeProposal(row: ProposalRow) {
  return {
    id: row.id,
    jobId: row.jobId,
    proposalDate: row.proposalDate,
    projectName: row.projectName,
    projectAddress: row.projectAddress,
    projectCity: row.projectCity,
    frp: row.frp,
    highImpactWallPanel: row.highImpactWallPanel,
    cornerGuards: row.cornerGuards,
    stainlessSteel: row.stainlessSteel,
    addsDeducts: row.addsDeducts,
    exclusions: row.exclusions,
    notes: row.notes,
    priceAmount: row.priceAmount,
    priceInWords: row.priceInWords,
    generatedAt: row.generatedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get("/jobs/:jobId/proposal", async (req, res): Promise<void> => {
  const params = GetProposalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }
  const [proposal] = await db
    .select()
    .from(proposalsTable)
    .where(eq(proposalsTable.jobId, params.data.jobId));
  if (!proposal) {
    res.status(404).json({ message: "Proposal not found" });
    return;
  }
  res.json(GetProposalResponse.parse(serializeProposal(proposal)));
});

router.post(
  "/jobs/:jobId/proposal/generate",
  async (req, res): Promise<void> => {
    const params = GenerateProposalParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ message: params.error.message });
      return;
    }
    const jobId = params.data.jobId;
    const [job] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId));
    if (!job) {
      res.status(404).json({ message: "Job not found" });
      return;
    }
    const [takeoff] = await db
      .select()
      .from(takeoffsTable)
      .where(eq(takeoffsTable.jobId, jobId));
    if (!takeoff) {
      res
        .status(409)
        .json({ message: "Save a takeoff before generating a proposal" });
      return;
    }

    const specs = await db
      .select({ texture: roomSpecsTable.texture })
      .from(roomSpecsTable)
      .where(eq(roomSpecsTable.jobId, jobId));
    const texture = firstValue(specs.map((s) => s.texture));

    const now = new Date();
    const values = {
      jobId,
      proposalDate: now.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      }),
      projectName: job.jobName,
      projectAddress: job.address,
      projectCity: job.city,
      frp: buildFrpSentence(takeoff, texture),
      highImpactWallPanel: "N/A",
      cornerGuards: "N/A",
      stainlessSteel: "N/A",
      addsDeducts: "N/A",
      exclusions: "",
      notes: STANDARD_NOTES,
      priceAmount: takeoff.totalPrice,
      priceInWords: amountInWords(takeoff.totalPrice),
      generatedAt: now,
      updatedAt: now,
    };

    const [saved] = await db
      .insert(proposalsTable)
      .values(values)
      .onConflictDoUpdate({ target: proposalsTable.jobId, set: values })
      .returning();

    req.log.info({ jobId }, "Proposal generated from takeoff");
    res.json(GenerateProposalResponse.parse(serializeProposal(saved!)));
  },
);

router.patch("/jobs/:jobId/proposal", async (req, res): Promise<void> => {
  const params = UpdateProposalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }
  const body = UpdateProposalBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: body.error.message });
    return;
  }

  const [updated] = await db
    .update(proposalsTable)
    .set({ ...body.data, updatedAt: new Date() })
    .where(eq(proposalsTable.jobId, params.data.jobId))
    .returning();
  if (!updated) {
    res.status(404).json({ message: "Proposal not found" });
    return;
  }
  res.json(UpdateProposalResponse.parse(serializeProposal(updated)));
});

export default router;
