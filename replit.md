# PanelBid

Bidding workflow tool for a wall panel installation company (FRP, stainless steel, PVC): job queue tracking, keyword management for future automated plan scanning, and PDF plan uploads with SHA-256 hashing.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- DB schema: `lib/db/src/schema/` (jobs, jobFiles, keywords)
- API contract: `lib/api-spec/openapi.yaml` (source of truth; run codegen after changes)
- API routes: `artifacts/api-server/src/routes/` (jobs.ts, keywords.ts, files.ts)
- Frontend: `artifacts/panelbid/` (react-vite at `/`); theme in `src/index.css`
- Uploaded PDFs: `artifacts/api-server/uploads/<jobId>/` (local disk, path in `job_files.file_path`)
- Takeoff and proposal rules, in ONE place: `artifacts/api-server/src/lib/takeoffRules.ts` (wall lengths, panel height, suggested sheets, moldings, glue, cost lines, the total, typed dollar amounts), `proposalRules.ts` (FRP line, generate / regenerate, export checks) and `materialList.ts` (the Material list and its printed page). They are pure (no database, no browser). The page reads them through `artifacts/panelbid/src/lib/takeoff-rules.ts`. Never write a rule in the page or in a route.
- Rule tests (pure, no database needed): `pnpm --filter @workspace/api-server run test:rules` (100 tests in five files under `artifacts/api-server/src/lib/`)

## Takeoff rules (the client's own answers, 2026-10-05)

- "Flat profit is for 8 and under." $800 flat at 8 sheets and under, else $1,000 a labor day.
- "Moldings come in 8' and 10' lengths and the kind you use is dependent on the height of the sheet. 8' high or less for 8' molding, and above 8' is the 10' molding. Glue is per sheet, one bucket does 12 sheets of any height." He has NOT said how many moldings a job takes: the count is typed by him; the page only starts from one per sheet and labels that as an assumption. Do not invent a count rule.
- "Yes we measure through windows and doors to get our waste. The elevation pages or notes on finish pages should tell you the height for the FRP, if not assume FRP from floor to ceiling. Ceiling height can be found on the reflected ceiling plan." Suggested sheets for a room = wall length ÷ 4 ft, rounded up, no extra waste, no opening deductions; sheet length is the shortest of 4x8 / 4x10 / 4x12 that covers the panel height. A room with no panel height uses its ceiling height and says "assumed to ceiling".
- "With how often prices are changing we decided for the moment this part can be unused so don't worry about labor or material prices. If possible allow us to input those prices manually." Prices are optional; a blank price is stored as 0 and shown as "not priced", never as $0.00, and a part-total is never passed to the proposal as a price.

## Architecture decisions

- File uploads use multer memory storage + local disk behind `routes/files.ts` only, so a future storage/intake service can swap in without touching the API contract
- SHA-256 hash computed at upload and stored for future deduplication (no dedup logic yet, by design)
- Upload endpoint has no typed OpenAPI request body (breaks Zod codegen); frontend posts raw FormData to `/api/jobs/:id/files`
- Keywords live in the DB (not hardcoded) and drive plan scanning (`plan_scans` table stores matches with a keyword snapshot so results survive keyword edits)
- PDF text extraction uses `unpdf` (pdfjs-dist breaks in the esbuild server bundle); files with no extractable text are flagged `needs_ocr` instead of failing
- Scanning runs automatically after upload (fire-and-forget) and via POST /jobs/:id/scan; per-file results are replaced atomically inside a transaction with a pg advisory lock to prevent races between concurrent scans
- Room spec extraction (POST /jobs/:id/extract-specs): finish-schedule candidate pages detected from page text (schedule terms or dense room tables near keyword matches), rendered to JPEG via `pdftoppm` shell-out (avoids pdfjs bundle issues), then Claude vision (`claude-sonnet-4-6` via Replit AI integration, strict-JSON prompt, null-over-guess) extracts room rows into `room_specs`; per-job atomic replace with advisory lock ns 74202
- Fire rating defaults to "Class C" only when no rating appears anywhere in extracted pages; such rows are flagged `fireRatingDefaulted` and the flag clears on manual edit
- Drizzle Date fields are serialized to ISO strings before Zod response validation (serializeJob/serializeFile helpers)

## Product

- Dashboard (`/`): job queue table with status badges, pipeline summary counts, manual job creation modal
- Job detail (`/jobs/:id`): job info, manual status dropdown, PDF upload/download/delete, Scan Results section (keyword/category/file/page/context) with Rescan button, "Needs OCR" badge on image-only PDFs
- Room Specs section on job detail: Extract Specs (needs_review jobs), editable table (inline edit/add/delete), ambiguous rows flagged for review, source page links into the PDF, Confirm Specs moves job to takeoff
- Takeoff section on job detail (takeoff / proposal_ready jobs): typed wall lengths give a suggested sheet count per room with its working; sheet rows marked "suggested" or "yours"; moldings by length and glue buckets; optional prices; a Material List on screen and as a printable page
- Bid Proposal section (proposal_ready jobs): made from the saved takeoff on the company template; every field editable; the price is read strictly and its words are written from it; export opens the browser's print window
- Settings (`/settings`): keyword management grouped by material category
- Out of scope so far: email intake, PDF parsing, PlanHub integration

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Update 1 (2026-10-05) made NO database change. The new takeoff values (`ceilingHeight` on room rows; `sheetsSource` and `moldingCount` on sheet rows) are optional fields inside the `takeoffs.room_rows` / `sheet_rows` JSON columns. Rows saved before the update have none of them and count as the person's own.
- Sheet rows marked `sheetsSource: "suggested"` follow the wall lengths; the server works them out again on every save and before every proposal. A row the person typed is never changed.
- A proposal is only made from the SAVED takeoff. The page refuses while the takeoff has unsaved changes; Regenerate rewrites only the FRP line and the price and keeps every other field.
- The price in words is always written from the price by the server; it is not a separate editable value.
- `src/lib/specExtractor.test.ts` needs a database and `pdftoppm`; the five rule test files above need neither.
- The wording added to the AI reader's instructions in update 1 (where heights come from) has NOT been tried against the real reader.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
