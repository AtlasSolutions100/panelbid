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
- Settings (`/settings`): keyword management grouped by material category
- Out of scope so far: email intake, PDF parsing, PlanHub integration

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
