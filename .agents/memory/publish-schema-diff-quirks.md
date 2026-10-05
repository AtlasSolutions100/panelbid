---
name: Publish-time schema diff quirks
description: Constraints that Replit's dev→prod publish schema diff serializes incorrectly, breaking deploys
---

# Publish-time schema diff quirks

Rule: avoid bare-boolean CHECK constraints (e.g. `CHECK (id)`) on tables in the dev database. Prefer no CHECK, or verify the publish diff before relying on one.

**Why:** Replit's Publish flow diffs the dev schema against production and re-serializes constraints. A `CHECK (id)` on a boolean column was re-emitted as the malformed `CHECK (CHECK (id))`, failing the production deploy with a syntax error (Aug 2026, exclusion_terms_seed_marker table).

**How to apply:** When startup DDL or drizzle schema adds CHECK constraints, run `explainSchemaDiff()` (build agent, CodeExecution) before republish to inspect the exact statements publish will execute. Fixing requires both editing the code AND dropping the constraint from the dev DB (the diff reads dev's live schema, not the code).
