import { Router } from 'express';
import { submitSwipeVote } from '../controllers/swipeVoteController.js';

const router = Router();

router.post('/swipe-votes', submitSwipeVote);

export default router;
