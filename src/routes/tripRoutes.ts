import { Router } from 'express';
import { requireUser } from '../middleware/sessionAuth.js';
import { listTrips, archiveTripById, unarchiveTripById, fetchTripStats, fetchTripScore, putTripLineLink, fetchMonthlyPlanningScore, fetchMonthlyTripSpend, fetchTripReceipts, detachTripReceipt, attachTripReceipt, fetchTripBasketComparison, fetchTripComparison, postConvertTripToFamily } from '../controllers/tripController.js';

/**
 * Souply 2.0 Phase 4 — the Apsipirkimai tab's trip API. Self-scoped via
 * TripMember (the list only ever returns the caller's memberships; archive
 * mutations are member-gated in the controller with 404-over-403 probing
 * defense, same policy as requireTripMember).
 */
const router = Router();

router.get('/trips', requireUser, listTrips);
router.get('/trips/:id/stats', requireUser, fetchTripStats);
router.get('/trips/:id/receipts', requireUser, fetchTripReceipts);
// Trip membership WITHOUT a store slot (off-plan shop) — the slot statement is
// the separate /shopping-lists/:id/link-receipt call.
router.get('/trips/:id/basket-comparison', requireUser, fetchTripBasketComparison);
router.post('/trips/:id/attach-receipt', requireUser, attachTripReceipt);
router.delete('/trips/:id/receipts/:receiptId', requireUser, detachTripReceipt);
// Family spec §7 "Convert to family shopping" — ONE-WAY (no inverse route
// exists, deliberately: see services/tripFamilyConversion).
router.post('/trips/:id/convert-to-family', requireUser, postConvertTripToFamily);
router.get('/trips/:id/score', requireUser, fetchTripScore);
router.get('/trips/:id/comparison', requireUser, fetchTripComparison);
router.post('/trips/:id/line-links', requireUser, putTripLineLink);
router.get('/planning-score/monthly', requireUser, fetchMonthlyPlanningScore);
router.get('/trips/spend', requireUser, fetchMonthlyTripSpend);
router.post('/trips/:id/archive', requireUser, archiveTripById);
router.post('/trips/:id/unarchive', requireUser, unarchiveTripById);

export default router;
