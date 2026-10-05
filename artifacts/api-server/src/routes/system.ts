/**
 * GET /system/check — what this server needs and whether it has it.
 *
 * Signed in only (it sits behind the gate like every other route) and
 * read-only. It answers ONLY: for each of the two PDF programs whether it
 * was found and how ("env", "path", "searched" or "missing"), how many
 * folders the PATH names, and whether /nix/store is there and has a poppler
 * folder. No path, no environment value, nothing about the uploads.
 *
 * The lookup is done once per server process (lib/pdfTools.ts), and the
 * page asks once, on Settings: this is not called on every page load.
 */
import { Router, type IRouter } from "express";
import { systemCheck } from "../lib/pdfTools";

const router: IRouter = Router();

router.get("/system/check", async (_req, res): Promise<void> => {
  const check = await systemCheck();
  res.set("Cache-Control", "no-store").json({
    pdfinfo: { found: check.pdfinfo.found, how: check.pdfinfo.how },
    pdftoppm: { found: check.pdftoppm.found, how: check.pdftoppm.how },
    pathEntries: check.pathEntries,
    nixStore: {
      exists: check.nixStore.exists,
      hasPopplerFolder: check.nixStore.hasPopplerFolder,
    },
  });
});

export default router;
