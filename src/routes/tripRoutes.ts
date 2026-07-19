import { Router } from 'express';
import { requireUser } from '../middleware/sessionAuth.js';
import { listTrips, archiveTripById, unarchiveTripById, fetchTripStats, fetchTripScore, putTripLineLink, fetchMonthlyPlanningScore, fetchTripReceipts, detachTripReceipt } from '../controllers/tripController.js';

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
router.delete('/trips/:id/receipts/:receiptId', requireUser, detachTripReceipt);
router.get('/trips/:id/score', requireUser, fetchTripScore);
router.post('/trips/:id/line-links', requireUser, putTripLineLink);
router.get('/planning-score/monthly', requireUser, fetchMonthlyPlanningScore);
router.post('/trips/:id/archive', requireUser, archiveTripById);
router.post('/trips/:id/unarchive', requireUser, unarchiveTripById);

export default router;
