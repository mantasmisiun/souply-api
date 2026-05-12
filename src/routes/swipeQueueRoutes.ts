import { Router } from 'express';
import {
    getSwipeQueue,
    submitDirectVote,
    submitSlot2Vote,
} from '../controllers/swipeQueueController.js';

const router = Router();

router.get('/users/:userId/swipe-queue', getSwipeQueue);
router.post('/users/:userId/swipe-vote', submitDirectVote);
router.post('/users/:userId/swipe-vote/slot2', submitSlot2Vote);

export default router;
