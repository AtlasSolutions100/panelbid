import {
  pgTable,
  serial,
  text,
  boolean,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const keywordCategoryEnum = pgEnum("keyword_category", [
  "frp",
  "stainless",
  "pvc",
  "high_impact",
  "manufacturer",
]);

export const keywordsTable = pgTable("keywords", {
  id: serial("id").primaryKey(),
  term: text("term").notNull(),
  category: keywordCategoryEnum("category").notNull(),
  active: boolean("active").notNull().default(true),
});

export const insertKeywordSchema = createInsertSchema(keywordsTable).omit({
  id: true,
});
export type InsertKeyword = z.infer<typeof insertKeywordSchema>;
export type Keyword = typeof keywordsTable.$inferSelect;
