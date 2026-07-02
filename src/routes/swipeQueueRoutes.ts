import { Router } from 'express';
import {
    getSwipeQueue,
    getVoluntaryQueueCount,
    submitDirectVote,
    submitSlot2Vote,
} from '../controllers/swipeQueueController.js';
import { getAliasCards, submitAliasVote } from '../controllers/storeProductAliasController.js';
import { requireUser, requireSelfUserParam } from '../middleware/sessionAuth.js';

const router = Router();

// Voter identity comes from the session token: requireUser sets req.authUserId and
// requireSelfUserParam pins the :userId in the path to it — so a spoofed userId can no
// longer cast votes as another account (the Sybil-against-consensus concern). Controllers
// still read params.userId, now guaranteed to equal the token subject.
router.get('/users/:userId/swipe-queue', requireUser, requireSelfUserParam, getSwipeQueue);
router.get('/users/:userId/voluntary-queue-count', requireUser, requireSelfUserParam, getVoluntaryQueueCount);
router.post('/users/:userId/swipe-vote', requireUser, requireSelfUserParam, submitDirectVote);
router.post('/users/:userId/swipe-vote/slot2', requireUser, requireSelfUserParam, submitSlot2Vote);
// H3 pending-alias (vocabulary) cards + votes.
router.get('/users/:userId/alias-cards', requireUser, requireSelfUserParam, getAliasCards);
router.post('/users/:userId/alias-votes', requireUser, requireSelfUserParam, submitAliasVote);

export default router;
