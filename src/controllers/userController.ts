import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { createUser, getUserById, updateLastActive } from '../models/userModel.js';
import { getUserPointsProfile } from '../services/userPointsService.js';
import { hasPendingMandatorySwipes, shouldShowBurstWarning } from '../services/swipeSessionService.js';
import { getPendingMandatorySwipeCount } from '../models/receiptModel.js';
import { getEquivalencesForUser, upsertEquivalence, deleteEquivalence, getUserProductMergeMap, type EquivalenceVerdict } from '../models/userEquivalenceModel.js';
import { getUserStats } from '../services/statsService.js';

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
        res.status(existing ? 200 : 201).json({ id });
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

export const fetchUserProfile = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = String(req.params.id);
        const user = await getUserById(id);
        if (!user) { res.status(404).json({ error: 'User not found' }); return; }

        const [pointsProfile, pendingSwipeCount, showBurstWarning] = await Promise.all([
            getUserPointsProfile(id),
            getPendingMandatorySwipeCount(id),
            shouldShowBurstWarning(id),
            updateLastActive(id),
        ]);

        res.json({ ...pointsProfile, pendingSwipes: pendingSwipeCount > 0, pendingSwipeCount, showBurstWarning });
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
        const stats = await getUserStats(userId);
        res.json(stats);
    } catch (error) {
        next(error);
    }
};