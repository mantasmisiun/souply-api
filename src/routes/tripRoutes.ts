import { Router } from 'express';
import { requireUser } from '../middleware/sessionAuth.js';
import { listTrips, archiveTripById, unarchiveTripById } from '../controllers/tripController.js';

/**
 * Souply 2.0 Phase 4 — the Apsipirkimai tab's trip API. Self-scoped via
 * TripMember (the list only ever returns the caller's memberships; archive
 * mutations are member-gated in the controller with 404-over-403 probing
 * defense, same policy as requireTripMember).
 */
const router = Router();

router.get('/trips', requireUser, listTrips);
router.post('/trips/:id/archive', requireUser, archiveTripById);
router.post('/trips/:id/unarchive', requireUser, unarchiveTripById);

export default router;
