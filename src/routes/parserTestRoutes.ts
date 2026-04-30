/**
 * Dev-only routes for the parser test harness.
 *
 * POST /api/parser-test/results
 *   Body: { runId, summary, receipts, ... }   (full JSON the phone builds)
 *   Saves to shared/receipts/_results/<runId>.json for offline diffing.
 */
import { Router } from 'express';
import { saveParserTestResult } from '../controllers/parserTestController.js';

const router = Router();
router.post('/parser-test/results', saveParserTestResult);

export default router;
