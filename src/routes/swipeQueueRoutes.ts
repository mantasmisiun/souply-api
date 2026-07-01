import { Router } from 'express';
import {
    getSwipeQueue,
    getVoluntaryQueueCount,
    submitDirectVote,
    submitSlot2Vote,
} from '../controllers/swipeQueueController.js';
import { getAliasCards, submitAliasVote } from '../controllers/storeProductAliasController.js';

const router = Router();

router.get('/users/:userId/swipe-queue', getSwipeQueue);
router.get('/users/:userId/voluntary-queue-count', getVoluntaryQueueCount);
router.post('/users/:userId/swipe-vote', submitDirectVote);
router.post('/users/:userId/swipe-vote/slot2', submitSlot2Vote);
// H3 pending-alias (vocabulary) cards + votes.
router.get('/users/:userId/alias-cards', getAliasCards);
router.post('/users/:userId/alias-votes', submitAliasVote);

export default router;
