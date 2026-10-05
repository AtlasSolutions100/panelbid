import { Router, type IRouter } from "express";
import healthRouter from "./health";
import jobsRouter from "./jobs";
import keywordsRouter from "./keywords";
import exclusionTermsRouter from "./exclusionTerms";
import filesRouter from "./files";
import scansRouter from "./scans";
import roomSpecsRouter from "./roomSpecs";
import takeoffsRouter from "./takeoffs";
import priceSheetsRouter from "./priceSheets";
import proposalsRouter from "./proposals";
import gmailRouter from "./gmail";
import contractorSourcesRouter from "./contractorSources";

const router: IRouter = Router();

router.use(healthRouter);
router.use(jobsRouter);
router.use(keywordsRouter);
router.use(exclusionTermsRouter);
router.use(filesRouter);
router.use(scansRouter);
router.use(roomSpecsRouter);
router.use(takeoffsRouter);
router.use(priceSheetsRouter);
router.use(proposalsRouter);
router.use(gmailRouter);
router.use(contractorSourcesRouter);

export default router;
