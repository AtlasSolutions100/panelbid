import { Router, type IRouter } from "express";
import { asc, eq } from "drizzle-orm";
import { db, exclusionTermsTable } from "@workspace/db";
import {
  ListExclusionTermsResponse,
  CreateExclusionTermBody,
  CreateExclusionTermResponse,
  UpdateExclusionTermParams,
  UpdateExclusionTermBody,
  UpdateExclusionTermResponse,
  DeleteExclusionTermParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/exclusion-terms", async (_req, res): Promise<void> => {
  const terms = await db
    .select()
    .from(exclusionTermsTable)
    .orderBy(asc(exclusionTermsTable.matchType), asc(exclusionTermsTable.term));
  res.json(ListExclusionTermsResponse.parse(terms));
});

router.post("/exclusion-terms", async (req, res): Promise<void> => {
  const parsed = CreateExclusionTermBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }

  const [created] = await db
    .insert(exclusionTermsTable)
    .values(parsed.data)
    .returning();
  res.status(201).json(CreateExclusionTermResponse.parse(created));
});

router.patch("/exclusion-terms/:exclusionTermId", async (req, res): Promise<void> => {
  const params = UpdateExclusionTermParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }
  const parsed = UpdateExclusionTermBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }

  const [updated] = await db
    .update(exclusionTermsTable)
    .set(parsed.data)
    .where(eq(exclusionTermsTable.id, params.data.exclusionTermId))
    .returning();

  if (!updated) {
    res.status(404).json({ message: "Exclusion term not found" });
    return;
  }
  res.json(UpdateExclusionTermResponse.parse(updated));
});

router.delete("/exclusion-terms/:exclusionTermId", async (req, res): Promise<void> => {
  const params = DeleteExclusionTermParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(exclusionTermsTable)
    .where(eq(exclusionTermsTable.id, params.data.exclusionTermId))
    .returning();

  if (!deleted) {
    res.status(404).json({ message: "Exclusion term not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
