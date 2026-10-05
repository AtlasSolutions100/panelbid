import { Router, type IRouter } from "express";
import { asc, eq } from "drizzle-orm";
import { db, contractorSourcesTable } from "@workspace/db";
import {
  ListContractorSourcesResponse,
  CreateContractorSourceBody,
  CreateContractorSourceResponse,
  UpdateContractorSourceParams,
  UpdateContractorSourceBody,
  UpdateContractorSourceResponse,
  DeleteContractorSourceParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

// Accepts "example.com" (incl. subdomains) or "person@example.com".
const DOMAIN_RE = /^@?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const EMAIL_RE = /^[^\s@]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

function isValidValue(value: string): boolean {
  const v = value.trim();
  return DOMAIN_RE.test(v) || EMAIL_RE.test(v);
}

function serialize(row: typeof contractorSourcesTable.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    value: row.value,
    active: row.active,
    notes: row.notes ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get("/contractor-sources", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(contractorSourcesTable)
    .orderBy(asc(contractorSourcesTable.name));
  res.json(ListContractorSourcesResponse.parse(rows.map(serialize)));
});

router.post("/contractor-sources", async (req, res): Promise<void> => {
  const parsed = CreateContractorSourceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  const value = parsed.data.value?.trim() || null;
  if (value !== null && !isValidValue(value)) {
    res.status(400).json({
      message: "Value must be a domain (example.com) or email address (person@example.com)",
    });
    return;
  }

  const [created] = await db
    .insert(contractorSourcesTable)
    .values({
      name: parsed.data.name.trim(),
      value,
      notes: parsed.data.notes?.trim() || null,
    })
    .returning();
  res.status(201).json(CreateContractorSourceResponse.parse(serialize(created!)));
});

router.patch("/contractor-sources/:contractorSourceId", async (req, res): Promise<void> => {
  const params = UpdateContractorSourceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }
  const parsed = UpdateContractorSourceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  const patch = { ...parsed.data };
  if (patch.value !== undefined) {
    const trimmed = patch.value?.trim() || null;
    if (trimmed !== null && !isValidValue(trimmed)) {
      res.status(400).json({
        message: "Value must be a domain (example.com) or email address (person@example.com)",
      });
      return;
    }
    patch.value = trimmed;
  }

  const [updated] = await db
    .update(contractorSourcesTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(contractorSourcesTable.id, params.data.contractorSourceId))
    .returning();

  if (!updated) {
    res.status(404).json({ message: "Contractor source not found" });
    return;
  }
  res.json(UpdateContractorSourceResponse.parse(serialize(updated)));
});

router.delete("/contractor-sources/:contractorSourceId", async (req, res): Promise<void> => {
  const params = DeleteContractorSourceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(contractorSourcesTable)
    .where(eq(contractorSourcesTable.id, params.data.contractorSourceId))
    .returning();

  if (!deleted) {
    res.status(404).json({ message: "Contractor source not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
