import { Router } from 'express';
import { requireUser, optionalUser } from '../middleware/sessionAuth.js';
import { requireTripMember } from '../middleware/resourceAuth.js';
import {
    createOwnHousehold, getOwnHousehold, leaveOwnHousehold, removeHouseholdMemberCtl, createHouseholdInvite,
    createTripInvite, previewJoin, claimJoin, listTripMembers, removeTripMember,
} from '../controllers/joinController.js';
import {
    getOwnSettlements, proposeOwnSettlement, confirmOwnSettlement,
} from '../controllers/householdSettlementController.js';
import { getOwnHistory } from '../controllers/householdHistoryController.js';

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
router.delete('/households/mine/members/:memberId', requireUser, removeHouseholdMemberCtl);
router.post('/households/mine/invites', requireUser, createHouseholdInvite);

// Settlements (§3.2) — self-scoped like the rest of /households/mine: the
// household comes from the caller's membership, never from the URL. The
// two-party rules (§3.2.1) are enforced in the service, not by a middleware,
// because they depend on the PROPOSAL, not on the route.
router.get('/households/mine/settlements', requireUser, getOwnSettlements);
router.post('/households/mine/settlements', requireUser, proposeOwnSettlement);
router.post('/households/mine/settlements/:settlementId/confirm', requireUser, confirmOwnSettlement);

// History (§5.2) — the ledger's PAST, keyset-paginated (?limit=&cursor=). Live
// state (balances, pending proposals, who is leaving) stays on the settlements
// read above; this is only what has already happened. Self-scoped for the same
// reason: the log is the household's money, so the household must come from the
// caller's membership and not from the request.
router.get('/households/mine/history', requireUser, getOwnHistory);

// Trip invites (any member may mint the QR)
router.post('/trips/:id/invites', requireUser, requireTripMember('id'), createTripInvite);
router.get('/trips/:id/members', requireUser, requireTripMember('id'), listTripMembers);
router.delete('/trips/:id/members/:userId', requireUser, requireTripMember('id'), removeTripMember);

// Join flow (token = capability)
// Preview is ANONYMOUS-friendly (the souply.lt landing shows it before install);
// membership fields appear only for authenticated callers.
router.get('/join/:code/preview', optionalUser, previewJoin);
router.post('/join/:code/claim', requireUser, claimJoin);

export default router;
