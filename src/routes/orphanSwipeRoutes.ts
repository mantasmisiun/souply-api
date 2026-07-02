import { Router } from 'express';
import {
    fetchExtraSwipeQueue,
    submitOrphanSwipeVote,
} from '../controllers/orphanSwipeController.js';
import { requireUser } from '../middleware/sessionAuth.js';

const router = Router();

// Identity from the token — the feed is self-scoped and the vote is attributed to the
// caller (closes the spoofable-userId Sybil vector). Controllers read req.authUserId.
router.get('/swipe/extra-queue', requireUser, fetchExtraSwipeQueue);
router.post('/swipe/orphan-vote', requireUser, submitOrphanSwipeVote);

export default router;
