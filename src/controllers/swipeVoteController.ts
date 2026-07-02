import { Request, Response, NextFunction } from 'express';
import {
    castSwipeVote,
    SwipeVote,
    undoSwipeVote,
} from '../services/swipeVoteService.js';
import { recordMandatorySwipe, shouldShowBurstWarning } from '../services/swipeSessionService.js';
import { getUserPointsProfile } from '../services/userPointsService.js';
import { getReceiptOwnerId } from '../models/receiptModel.js';
import { withDeadlockRetry } from '../utils/withDeadlockRetry.js';

const VALID_VOTES: SwipeVote[] = ['identical', 'similar', 'different'];

export const submitSwipeVote = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const {
            receiptId,
            receiptLineIdx,
            candidateStoreProductId,
            vote,
            dwellMs,
            isMandatory,
        } = req.body ?? {};

        // Voter identity comes from the session token (requireUser), never the body.
        const userId = req.authUserId;
        if (!userId) {
            res.status(401).json({ error: 'auth-required' });
            return;
        }
        if (!Number.isFinite(receiptId)) {
            res.status(400).json({ error: 'receiptId is required' });
            return;
        }
        // The swipe acts on the caller's OWN receipt line — bind receiptId to the owner.
        const ownerId = await getReceiptOwnerId(Number(receiptId));
        if (ownerId === null) {
            res.status(404).json({ error: 'receipt not found' });
            return;
        }
        if (ownerId !== userId) {
            res.status(403).json({ error: 'forbidden' });
            return;
        }
        if (!Number.isFinite(receiptLineIdx) || receiptLineIdx < 0) {
            res.status(400).json({ error: 'receiptLineIdx must be a non-negative integer' });
            return;
        }
        if (!Number.isFinite(candidateStoreProductId)) {
            res.status(400).json({ error: 'candidateStoreProductId is required' });
            return;
        }
        if (!VALID_VOTES.includes(vote)) {
            res.status(400).json({ error: 'vote must be identical, similar, or different' });
            return;
        }
        const dwell = Number.isFinite(dwellMs) ? Number(dwellMs) : 0;

        const result = await withDeadlockRetry(() => castSwipeVote({
            userId: String(userId),
            receiptId: Number(receiptId),
            receiptLineIdx: Number(receiptLineIdx),
            candidateStoreProductId: Number(candidateStoreProductId),
            vote,
            dwellMs: dwell,
            isMandatory: Boolean(isMandatory),
        }), { label: 'swipe-vote' });

        let burstWarning = false;
        if (isMandatory && result.ok && result.effect !== 'dropped-rate-limit') {
            await recordMandatorySwipe(Number(receiptId), dwell);
            if (result.isBurst) {
                burstWarning = await shouldShowBurstWarning(String(userId));
            }
        }

        const { level } = await getUserPointsProfile(String(userId));
        res.json({ ...result, burstWarning, level });
    } catch (error) {
        next(error);
    }
};

/**
 * Undo the most recent swipe vote for a given (userId, receipt, line,
 * candidate). Called by the mobile toast when the user taps "Atšaukti".
 */
export const undoSwipeVoteHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { receiptId, receiptLineIdx, candidateStoreProductId } = req.body ?? {};

        const userId = req.authUserId;
        if (!userId) {
            res.status(401).json({ error: 'auth-required' });
            return;
        }
        if (!Number.isFinite(receiptId)) {
            res.status(400).json({ error: 'receiptId is required' });
            return;
        }
        const ownerId = await getReceiptOwnerId(Number(receiptId));
        if (ownerId === null) {
            res.status(404).json({ error: 'receipt not found' });
            return;
        }
        if (ownerId !== userId) {
            res.status(403).json({ error: 'forbidden' });
            return;
        }
        if (!Number.isFinite(receiptLineIdx) || receiptLineIdx < 0) {
            res.status(400).json({ error: 'receiptLineIdx must be a non-negative integer' });
            return;
        }
        if (!Number.isFinite(candidateStoreProductId)) {
            res.status(400).json({ error: 'candidateStoreProductId is required' });
            return;
        }

        const result = await withDeadlockRetry(() => undoSwipeVote({
            userId: String(userId),
            receiptId: Number(receiptId),
            receiptLineIdx: Number(receiptLineIdx),
            candidateStoreProductId: Number(candidateStoreProductId),
        }), { label: 'swipe-vote-undo' });

        res.json(result);
    } catch (error) {
        next(error);
    }
};
