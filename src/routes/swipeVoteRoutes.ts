import { Router } from 'express';
import {
    submitSwipeVote,
    undoSwipeVoteHandler,
} from '../controllers/swipeVoteController.js';
import { requireUser } from '../middleware/sessionAuth.js';

const router = Router();

// Voter identity from the token; each handler additionally binds the body receiptId to
// the caller (the swipe acts on the user's OWN receipt line).
router.post('/swipe-votes', requireUser, submitSwipeVote);
router.post('/swipe-votes/undo', requireUser, undoSwipeVoteHandler);

export default router;
