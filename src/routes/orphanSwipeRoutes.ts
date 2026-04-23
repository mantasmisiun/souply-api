import { Router } from 'express';
import {
    fetchExtraSwipeQueue,
    submitOrphanSwipeVote,
} from '../controllers/orphanSwipeController.js';

const router = Router();

router.get('/swipe/extra-queue', fetchExtraSwipeQueue);
router.post('/swipe/orphan-vote', submitOrphanSwipeVote);

export default router;
