import { Router, type IRouter } from "express";
import { asc, eq } from "drizzle-orm";
import { db, keywordsTable } from "@workspace/db";
import {
  ListKeywordsResponse,
  CreateKeywordBody,
  CreateKeywordResponse,
  UpdateKeywordParams,
  UpdateKeywordBody,
  UpdateKeywordResponse,
  DeleteKeywordParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/keywords", async (_req, res): Promise<void> => {
  const keywords = await db
    .select()
    .from(keywordsTable)
    .orderBy(asc(keywordsTable.category), asc(keywordsTable.term));
  res.json(ListKeywordsResponse.parse(keywords));
});

router.post("/keywords", async (req, res): Promise<void> => {
  const parsed = CreateKeywordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }

  const [created] = await db
    .insert(keywordsTable)
    .values(parsed.data)
    .returning();
  res.status(201).json(CreateKeywordResponse.parse(created));
});

router.patch("/keywords/:keywordId", async (req, res): Promise<void> => {
  const params = UpdateKeywordParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }
  const parsed = UpdateKeywordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }

  const [updated] = await db
    .update(keywordsTable)
    .set(parsed.data)
    .where(eq(keywordsTable.id, params.data.keywordId))
    .returning();

  if (!updated) {
    res.status(404).json({ message: "Keyword not found" });
    return;
  }
  res.json(UpdateKeywordResponse.parse(updated));
});

router.delete("/keywords/:keywordId", async (req, res): Promise<void> => {
  const params = DeleteKeywordParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(keywordsTable)
    .where(eq(keywordsTable.id, params.data.keywordId))
    .returning();

  if (!deleted) {
    res.status(404).json({ message: "Keyword not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
