import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import pool from '../config/db.js';
import { avatarSignedUrl } from '../services/storageService.js';
import { createUser, getUserById, updateLastActive } from '../models/userModel.js';
import { getUserPointsProfile } from '../services/userPointsService.js';
import { hasPendingMandatorySwipes, shouldShowBurstWarning } from '../services/swipeSessionService.js';
import { getPendingMandatorySwipeCount } from '../models/receiptModel.js';
import { listTripsForUser } from '../services/tripListService.js';
import { getEquivalencesForUser, upsertEquivalence, deleteEquivalence, getUserProductMergeMap, type EquivalenceVerdict } from '../models/userEquivalenceModel.js';
import { getUserStats } from '../services/statsService.js';
import { getVoteHistory, orderPair, type MatchVote } from '../models/storeProductMatchModel.js';
import { editVote } from '../services/swipeVoteService.js';
import { deleteUser } from '../services/userDeletionService.js';
import { issueSessionToken } from '../services/authService.js';

export const addUser = async (req: Request, res: Response, next: NextFunction) => {
    try {
        // Device-generated UUIDs take precedence: the app creates its own
        // UUID on first launch and persists it to AsyncStorage, so the
        // device is the source of truth for its identity. A POST without a
        // body still works — the server generates one and returns it — but
        // the mobile client always sends its own.
        const bodyId = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
        const id = bodyId.length > 0 ? bodyId : crypto.randomUUID();

        // UUID-shape validation: rough guard against garbage payloads.
        if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) {
            res.status(400).json({ error: 'id must be a UUID' });
            return;
        }

        // Idempotent INSERT IGNORE inside createUser — safe to call repeatedly.
        // First-launch sync may retry after a flaky network, and the backend
        // returns 200 (not 201) when the row already existed so callers can
        // distinguish but don't have to.
        const existing = await getUserById(id);
        await createUser(id);

        // Anonymous session token: this is the bearer the app sends on every
        // per-user route (receipts, swipe votes). Issued ONLY for anonymous users —
        // a VERIFIED account gets its token from POST /api/auth/oauth, so we must
        // never mint one here for a verified UUID (that would let anyone holding a
        // verified user's id obtain a valid session for it). Verified callers simply
        // get {id} back and keep using their OAuth token.
        const isVerifiedUser = !!existing && existing.authProvider != null;
        const token = isVerifiedUser ? undefined : await issueSessionToken(id);
        res.status(existing ? 200 : 201).json({ id, ...(token ? { token } : {}) });
    } catch (error) {
        next(error);
    }
};

export const fetchUserById = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = String(req.params.id);
        if (!id) {
            res.status(400).json({ error: 'User ID is required' });
            return;
        }
        const user = await getUserById(id);
        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        res.json(user);
    } catch (error) {
        next(error);
    }
};

export const updateUserLastActive = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = String(req.params.id);
        if (!id) {
            res.status(400).json({ error: 'User ID is required' });
            return;
        }
        const user = await getUserById(id);
        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        await updateLastActive(id);
        res.json({ message: 'User last active time updated' });
    } catch (error) {
        next(error);
    }
};

/**
 * Souply 2.0 tab badges — ONE call replacing the client's 3-fetch poller.
 * Phase 4: `trips` now counts REAL trips (non-archived, derived stage 1-4)
 * via the batched trip list — every basket/list/receipt mints its trip at
 * persist time (tripLinkService), so the Trip table is authoritative.
 */
export const fetchTabBadges = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = String(req.params.id);
        const [trips, pendingSwipeCount] = await Promise.all([
            listTripsForUser(id),
            getPendingMandatorySwipeCount(id),
        ]);
        const active = trips.filter(t => t.archivedAt == null && t.stage < 5).length;
        res.json({ trips: active, pendingSwipes: pendingSwipeCount });
    } catch (error) {
        next(error);
    }
};

export const fetchUserProfile = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = String(req.params.id);
        const user = await getUserById(id);
        if (!user) { res.status(404).json({ error: 'User not found' }); return; }

        const [pointsProfile, pendingSwipeCount, showBurstWarning, aggRows] = await Promise.all([
            getUserPointsProfile(id),
            getPendingMandatorySwipeCount(id),
            shouldShowBurstWarning(id),
            // Aggregate stats across the creator's own (non-default) templates:
            // count + total visits + uses + follower (collective) savings.
            pool.query(
                `SELECT COUNT(*)                          AS templateCount,
                        COALESCE(SUM(visitCount), 0)      AS totalVisits,
                        COALESCE(SUM(useCount), 0)        AS totalUses,
                        COALESCE(SUM(collectiveSavingsEur), 0) AS totalSavings
                   FROM BasketTemplate
                  WHERE userId = ? AND isDefault = 0`,
                [id],
            ),
            updateLastActive(id), // fire-and-forget; result unused
        ]);
        const agg = (aggRows as any)?.[0]?.[0] ?? {};

        res.json({
            ...pointsProfile,
            pendingSwipes: pendingSwipeCount > 0,
            pendingSwipeCount,
            showBurstWarning,
            // Surface the admin flag so the client can decide whether to
            // show the "Pereiti į admin panelį" button on the Profilis tab.
            isAdmin: !!(user as any).isAdmin,
            role: (user as any).adminRole ?? null,
            // Identity for the profile header (avatar + name + @handle).
            firstName: (user as any).firstName ?? null,
            lastName: (user as any).lastName ?? null,
            displayName: (user as any).displayName ?? null,
            username: (user as any).username ?? null,
            avatarUrl: await avatarSignedUrl((user as any).avatarUrl),
            // Aggregate template stats for the profile cards.
            templateCount: Number(agg.templateCount ?? 0),
            totalVisits: Number(agg.totalVisits ?? 0),
            totalUses: Number(agg.totalUses ?? 0),
            totalFollowerSavingsEur: Number(agg.totalSavings ?? 0),
        });
    } catch (error) {
        next(error);
    }
};

export const fetchUserEquivalences = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = String(req.params.id);
        const equivalences = await getEquivalencesForUser(id);
        res.json(equivalences);
    } catch (error) {
        next(error);
    }
};

export const putUserEquivalence = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = String(req.params.id);
        const { spIdA, spIdB, verdict } = req.body ?? {};
        if (!Number.isInteger(spIdA) || !Number.isInteger(spIdB) || !['same', 'different'].includes(verdict)) {
            res.status(400).json({ error: 'spIdA, spIdB (integers) and verdict (same|different) are required' });
            return;
        }
        await upsertEquivalence(userId, spIdA, spIdB, verdict as EquivalenceVerdict);
        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
};

export const deleteUserEquivalence = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = String(req.params.id);
        const { spIdA, spIdB } = req.body ?? {};
        if (!Number.isInteger(spIdA) || !Number.isInteger(spIdB)) {
            res.status(400).json({ error: 'spIdA and spIdB (integers) are required' });
            return;
        }
        await deleteEquivalence(userId, spIdA, spIdB);
        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
};

// GET /users/:id/product-merge-map?productIds=1,2,3
// Returns { hideId: keepId } pairs for products in the given list that the
// user has personally linked via 'same' swipe verdicts.
export const fetchUserProductMergeMap = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = String(req.params.id);
        const raw = String(req.query.productIds ?? '');
        const productIds = raw.split(',').map(Number).filter(n => Number.isInteger(n) && n > 0);
        const map = await getUserProductMergeMap(userId, productIds);
        const obj: Record<number, number> = {};
        map.forEach((keepId, hideId) => { obj[hideId] = keepId; });
        res.json(obj);
    } catch (error) {
        next(error);
    }
};

export const fetchUserStats = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = String(req.params.id);
        const stats = await getUserStats(userId, req.locale);
        res.json(stats);
    } catch (error) {
        next(error);
    }
};

// GET /users/:id/votes?limit=&cursor=&search=&vote=
// Returns a paginated, optionally filtered vote history page.
export const fetchUserVoteHistory = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = String(req.params.id);
        const limit  = req.query.limit  ? Number(req.query.limit)  : undefined;
        const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
        const search = req.query.search ? String(req.query.search) : undefined;
        const vote   = req.query.vote   ? String(req.query.vote)   : undefined;

        const page = await getVoteHistory(userId, {
            limit: limit && Number.isFinite(limit) ? limit : undefined,
            cursor,
            search,
            vote: (['identical', 'similar', 'different'].includes(vote ?? '')) ? vote as any : undefined,
        });
        res.json(page);
    } catch (error) {
        next(error);
    }
};

// DELETE /users/:id
// User-initiated self-delete. Always runs in `anonymize` mode:
//   - The User row + receipts + receipt images + basket + shopping list are deleted
//   - StoreProductMatchVote.userId is nulled (vote contributions stay in the
//     global price catalog, no longer attributable to the user)
//   - Receipt parsedData has PII stripped (footer.rawText, header.rawText,
//     products[].rawLines), though Receipt rows themselves CASCADE-delete
//     via the User FK
//
// No auth gate: the userId in the path IS the requester's claim of identity
// (device UUID stored in AsyncStorage). This matches the rest of the API
// surface — same security posture as POST /users, GET /users/:id, etc.
// The `purge` (bad-actor) mode stays gated behind /admin/users/:id.
export const deleteSelfAccount = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = String(req.params.id ?? '').trim();
        if (!userId) {
            res.status(400).json({ error: 'userId is required' });
            return;
        }
        const result = await deleteUser(userId, 'anonymize');
        if (!result.deleted) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        res.status(204).send();
    } catch (error) {
        next(error);
    }
};

// PUT /users/:id/votes/pair
// Edit an existing vote from the history screen. Body: { spIdA, spIdB, vote }.
// dwellMs is not accepted — retrospective edits have no dwell time.
export const editUserVotePair = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = String(req.params.id);
        const spIdA = Number(req.body?.spIdA);
        const spIdB = Number(req.body?.spIdB);
        const vote = req.body?.vote as string;

        if (!Number.isFinite(spIdA) || !Number.isFinite(spIdB) || spIdA <= 0 || spIdB <= 0) {
            res.status(400).json({ error: 'spIdA and spIdB must be positive integers' });
            return;
        }
        if (!['identical', 'similar', 'different'].includes(vote)) {
            res.status(400).json({ error: 'vote must be identical | similar | different' });
            return;
        }

        const { spIdA: a, spIdB: b } = orderPair(spIdA, spIdB);
        const result = await editVote({ userId, spIdA: a, spIdB: b, vote: vote as MatchVote });
        res.json(result);
    } catch (error) {
        next(error);
    }
};