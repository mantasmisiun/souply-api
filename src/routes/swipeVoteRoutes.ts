import { Router } from 'express';
import {
    submitSwipeVote,
    undoSwipeVoteHandler,
} from '../controllers/swipeVoteController.js';

const router = Router();

router.post('/swipe-votes', submitSwipeVote);
router.post('/swipe-votes/undo', undoSwipeVoteHandler);

export default router;
