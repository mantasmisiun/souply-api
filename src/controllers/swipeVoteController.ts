import { Request, Response, NextFunction } from 'express';
import {
    castSwipeVote,
    SwipeVote,
    undoSwipeVote,
} from '../services/swipeVoteService.js';
import { recordMandatorySwipe, shouldShowBurstWarning } from '../services/swipeSessionService.js';

const VALID_VOTES: SwipeVote[] = ['identical', 'similar', 'different'];

export const submitSwipeVote = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const {
            userId,
            receiptId,
            receiptLineIdx,
            candidateStoreProductId,
            vote,
            dwellMs,
            isMandatory,
        } = req.body ?? {};

        if (!userId || typeof userId !== 'string') {
            res.status(400).json({ error: 'userId is required' });
            return;
        }
        if (!Number.isFinite(receiptId)) {
            res.status(400).json({ error: 'receiptId is required' });
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

        const result = await castSwipeVote({
            userId: String(userId),
            receiptId: Number(receiptId),
            receiptLineIdx: Number(receiptLineIdx),
            candidateStoreProductId: Number(candidateStoreProductId),
            vote,
            dwellMs: dwell,
            isMandatory: Boolean(isMandatory),
        });

        let burstWarning = false;
        if (isMandatory && result.ok && result.effect !== 'dropped-rate-limit') {
            await recordMandatorySwipe(Number(receiptId), dwell);
            if (result.isBurst) {
                burstWarning = await shouldShowBurstWarning(String(userId));
            }
        }

        res.json({ ...result, burstWarning });
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
        const { userId, receiptId, receiptLineIdx, candidateStoreProductId } = req.body ?? {};

        if (!userId || typeof userId !== 'string') {
            res.status(400).json({ error: 'userId is required' });
            return;
        }
        if (!Number.isFinite(receiptId)) {
            res.status(400).json({ error: 'receiptId is required' });
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

        const result = await undoSwipeVote({
            userId: String(userId),
            receiptId: Number(receiptId),
            receiptLineIdx: Number(receiptLineIdx),
            candidateStoreProductId: Number(candidateStoreProductId),
        });

        res.json(result);
    } catch (error) {
        next(error);
    }
};
