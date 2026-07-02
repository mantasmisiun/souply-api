import { Request, Response, NextFunction } from 'express';
import {
    fetchExtraQueue,
    countUnresolved,
    findOrphansNeedingRefill,
} from '../models/orphanSwipeCandidateModel.js';
import {
    castOrphanSwipeVote,
} from '../services/orphanSwipeService.js';
import { refillForOrphans } from '../scripts/seedOrphanSwipeCandidates.js';
import type { SwipeVote } from '../services/swipeVoteService.js';

const VALID_VOTES: SwipeVote[] = ['identical', 'similar', 'different'];

const MAX_LIMIT = 30;
const DEFAULT_LIMIT = 30;

/**
 * Pool-level watermark: if total unresolved candidates across the whole
 * system falls below this, the feed endpoint kicks off a background refill
 * (non-blocking) the next time anyone asks for cards.
 */
const POOL_WATERMARK = 500;

/** How many orphans to refill per background run. Keeps each pass cheap. */
const REFILL_BATCH_SIZE = 200;

/**
 * Module-level flag prevents overlapping refills when many users hit the
 * endpoint simultaneously. A refill takes a few seconds of CPU; we don't
 * need a distributed lock for a single-node thesis-scale server.
 */
let refillInFlight = false;

function maybeScheduleBackgroundRefill(): void {
    if (refillInFlight) return;
    refillInFlight = true;
    // setImmediate keeps the refill off the response path; any user that
    // arrives during the refill gets served from whatever's currently
    // unresolved. Next user after refill sees freshly topped-up candidates.
    setImmediate(async () => {
        try {
            const unresolved = await countUnresolved();
            if (unresolved >= POOL_WATERMARK) {
                return; // raced with another request that already refilled
            }
            const orphanIds = await findOrphansNeedingRefill(REFILL_BATCH_SIZE);
            if (orphanIds.length === 0) return;
            const added = await refillForOrphans(orphanIds);
            console.log(
                `[orphan-refill] refilled ${orphanIds.length} orphans, ` +
                `${added} rows upserted (pool was ${unresolved})`
            );
        } catch (err) {
            console.error('[orphan-refill] background refill failed:', err);
        } finally {
            refillInFlight = false;
        }
    });
}

/**
 * GET /api/swipe/extra-queue?userId=<string>&limit=<int>
 *
 * Returns up to `limit` orphan↔candidate cards for the user. Filters out
 * pairs the user has already voted on. Cards are priceless by design —
 * the frontend renders only product identity (name, brand, amount, image,
 * chain) so the user judges "same or different product?" without seeing
 * a price-driven nudge.
 *
 * Side effect: if the system-wide unresolved candidate pool is below the
 * watermark, a background refill is scheduled before returning.
 */
export const fetchExtraSwipeQueue = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const userId = req.authUserId ?? ''; // token subject (requireUser); query userId ignored
        if (!userId) {
            res.status(401).json({ error: 'auth-required' });
            return;
        }
        const rawLimit = Number(req.query.limit);
        const limit =
            Number.isFinite(rawLimit) && rawLimit > 0
                ? Math.min(Math.trunc(rawLimit), MAX_LIMIT)
                : DEFAULT_LIMIT;

        const items = await fetchExtraQueue(userId, limit);

        // Cheap post-query supply check so we don't scan every request.
        if (items.length < limit) {
            const unresolved = await countUnresolved();
            if (unresolved < POOL_WATERMARK) {
                maybeScheduleBackgroundRefill();
            }
        }

        res.json({ items });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/swipe/orphan-vote
 * Body: { userId, candidateId, vote, dwellMs }
 *
 * Casts a vote on the SP pair behind OrphanSwipeCandidate[candidateId].
 * Votes feed the same StoreProductMatch/Vote tables as receipt swipes;
 * the only difference is the dwell threshold (minDwellMsOrphan = 700ms)
 * and the lack of a Price.priceVerified flip.
 */
export const submitOrphanSwipeVote = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const { candidateId, vote, dwellMs } = req.body ?? {};
        const userId = req.authUserId; // token subject (requireUser); body userId ignored

        if (!userId || typeof userId !== 'string') {
            res.status(401).json({ error: 'auth-required' });
            return;
        }
        if (!Number.isFinite(candidateId)) {
            res.status(400).json({ error: 'candidateId is required' });
            return;
        }
        if (!VALID_VOTES.includes(vote)) {
            res.status(400).json({ error: 'vote must be identical, similar, or different' });
            return;
        }
        const dwell = Number.isFinite(dwellMs) ? Number(dwellMs) : 0;

        const result = await castOrphanSwipeVote({
            userId: String(userId),
            candidateId: Number(candidateId),
            vote,
            dwellMs: dwell,
        });

        res.json(result);
    } catch (error) {
        next(error);
    }
};
