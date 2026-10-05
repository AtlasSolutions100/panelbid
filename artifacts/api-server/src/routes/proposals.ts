import { Router, type IRouter } from "express";
import { asc, eq } from "drizzle-orm";
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
import {
  buildProposalValues,
  priceProblem,
  sheetAllotment,
} from "../lib/proposalRules";
import {
  amountInWords,
  refreshSuggestedRows,
  roundToCents,
} from "../lib/takeoffRules";

const router: IRouter = Router();

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
    const [savedTakeoff] = await db
      .select()
      .from(takeoffsTable)
      .where(eq(takeoffsTable.jobId, jobId));
    // The sheet count and sizes come from the takeoff as it is now: suggested
    // rows are worked out again from the rooms, never read from an old count.
    const takeoff = savedTakeoff && {
      ...savedTakeoff,
      sheetRows: refreshSuggestedRows(savedTakeoff.roomRows, savedTakeoff.sheetRows),
    };
    if (!takeoff) {
      res
        .status(409)
        .json({ message: "Save a takeoff before generating a proposal" });
      return;
    }
    // A proposal must print a sheet count: refuse, in words, when there is none.
    if (sheetAllotment(takeoff.sheetRows).total <= 0) {
      res.status(409).json({
        message:
          "The saved takeoff has no sheets. Type the wall lengths or the sheet counts, save the takeoff, then make the proposal.",
      });
      return;
    }

    // Texture is kept per room on the room specs (takeoff rows do not carry it).
    const textures = await db
      .select({
        roomName: roomSpecsTable.roomName,
        roomNumber: roomSpecsTable.roomNumber,
        texture: roomSpecsTable.texture,
      })
      .from(roomSpecsTable)
      .where(eq(roomSpecsTable.jobId, jobId))
      .orderBy(asc(roomSpecsTable.id));

    const [existing] = await db
      .select()
      .from(proposalsTable)
      .where(eq(proposalsTable.jobId, jobId));

    // Always made from the takeoff as it is saved NOW. On a regenerate, only
    // the FRP line and the price are rewritten; everything else the person
    // typed into the proposal is kept (see buildProposalValues).
    const now = new Date();
    const values = {
      jobId,
      ...buildProposalValues({
        job,
        takeoff,
        textures,
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

  // The figure and the words always come from the same number: whenever a
  // price is sent, the words are written from it here. Words sent by the
  // browser are never stored on their own.
  const { priceInWords: _ignoredWords, ...edits } = body.data;
  // A price below 0 is refused in words. It is not turned into 0 silently:
  // nothing of the request is stored.
  const refused =
    edits.priceAmount === undefined ? null : priceProblem(edits.priceAmount);
  if (refused !== null) {
    res.status(400).json({ message: `The proposal was not saved. ${refused}` });
    return;
  }
  const price =
    edits.priceAmount === undefined
      ? {}
      : (() => {
          const priceAmount = roundToCents(edits.priceAmount);
          return {
            priceAmount,
            priceInWords: priceAmount > 0 ? amountInWords(priceAmount) : "",
          };
        })();

  const [updated] = await db
    .update(proposalsTable)
    .set({ ...edits, ...price, updatedAt: new Date() })
    .where(eq(proposalsTable.jobId, params.data.jobId))
    .returning();
  if (!updated) {
    res.status(404).json({ message: "Proposal not found" });
    return;
  }
  res.json(UpdateProposalResponse.parse(serializeProposal(updated)));
});

export default router;
