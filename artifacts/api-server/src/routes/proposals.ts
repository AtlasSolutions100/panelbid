import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  jobsTable,
  takeoffsTable,
  proposalsTable,
  roomSpecsTable,
  type ProposalRow,
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
import { buildProposalValues } from "../lib/proposalRules";

const router: IRouter = Router();

function firstValue(values: (string | null | undefined)[]): string | null {
  for (const v of values) {
    if (v && v.trim().length > 0) return v.trim();
  }
  return null;
}

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

    const [existing] = await db
      .select()
      .from(proposalsTable)
      .where(eq(proposalsTable.jobId, jobId));

    const now = new Date();
    const values = {
      jobId,
      ...buildProposalValues({
        job,
        takeoff,
        texture,
        now,
        existing: existing ?? null,
      }),
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
