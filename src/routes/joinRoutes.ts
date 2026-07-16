import { Router } from 'express';
import { requireUser } from '../middleware/sessionAuth.js';
import { requireTripMember } from '../middleware/resourceAuth.js';
import {
    createOwnHousehold, getOwnHousehold, leaveOwnHousehold, createHouseholdInvite,
    createTripInvite, previewJoin, claimJoin,
} from '../controllers/joinController.js';

/**
 * Souply 2.0 Phase 1c — households + invite claim flow.
 * Token-as-capability pattern (like list share claims): /join/:code routes
 * need only requireUser; membership routes are strictly self-scoped; the trip
 * invite mint is member-gated.
 */
const router = Router();

// Households (self-scoped — no ids in the URL, ever)
router.post('/households', requireUser, createOwnHousehold);
router.get('/households/mine', requireUser, getOwnHousehold);
router.delete('/households/mine/membership', requireUser, leaveOwnHousehold);
router.post('/households/mine/invites', requireUser, createHouseholdInvite);

// Trip invites (any member may mint the QR)
router.post('/trips/:id/invites', requireUser, requireTripMember('id'), createTripInvite);

// Join flow (token = capability)
router.get('/join/:code/preview', requireUser, previewJoin);
router.post('/join/:code/claim', requireUser, claimJoin);

export default router;
