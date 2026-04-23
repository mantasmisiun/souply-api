import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import {
    createShoppingList,
    getShoppingListById,
    getShoppingListsByUserId,
    deleteShoppingList,
    updateShoppingListStatus,
    updateShoppingListBasket,
    getShoppingListByBasketId,
    getBasketIdByListId,
    duplicateShoppingList,
} from '../models/shoppingListModel.js';
import {
    createListItemsBatch,
    checkAllItemsByListId,
    duplicateListItems,
} from '../models/shoppingListItemModel.js';
import { getBasketById, updateBasketStatus } from '../models/basketModel.js';
import { addShoppingListMember, isShoppingListMember } from '../models/shoppingListMemberModel.js';
import {
    createShareToken,
    getShareTokenByToken,
    markShareTokenClaimed,
} from '../models/shoppingListShareTokenModel.js';

/**
 * POST /api/shopping-lists
 * Body: { userId, storeId, basketId?, items?: [{ productId?, storeProductId?, quantity, price? }] }
 *
 * Atomic creation. If `items[]` is provided, they're inserted in one
 * batch inside the same transaction as the list. Also owns the basket-
 * side side-effect of flipping the basket to `inProgress` when a
 * basketId is supplied.
 *
 * Refuses with 409 if the user already has an active list pointing at
 * the same basketId — prevents orphaned siblings (enforced at DB level
 * too via UNIQUE(basketId)).
 */
export const addShoppingList = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId, storeId, basketId, items } = req.body ?? {};
        if (!userId || !storeId) {
            res.status(400).json({ error: 'User ID and Store ID are required' });
            return;
        }
        if (items !== undefined && !Array.isArray(items)) {
            res.status(400).json({ error: 'items must be an array' });
            return;
        }

        // Duplicate-per-basket guard. The DB also enforces this, but a
        // friendly 409 with the existing list id lets the UI route users
        // to the existing list instead of popping a raw error.
        if (basketId) {
            const existing = await getShoppingListByBasketId(Number(basketId));
            if (existing) {
                res.status(409).json({
                    error: 'A shopping list already exists for this basket',
                    listId: existing.id,
                });
                return;
            }
        }

        const conn = await (pool as any).getConnection();
        try {
            await conn.beginTransaction();
            const id = await createShoppingList(userId, storeId, basketId ?? null, conn);
            // Owner membership row — same transaction so the list
            // and its owner either both exist or neither does.
            await addShoppingListMember(id, userId, 'owner', conn);
            if (Array.isArray(items) && items.length > 0) {
                await createListItemsBatch(
                    id,
                    items.map((it: any) => ({
                        productId: it.productId ?? null,
                        storeProductId: it.storeProductId ?? null,
                        quantity: Number(it.quantity),
                        price: it.price ?? null,
                    })),
                    conn
                );
            }
            if (basketId) {
                // Pass `conn` so the UPDATE runs in the same transaction
                // as the ShoppingList INSERT. Without this, the INSERT's
                // FK lock on Basket(id) and the UPDATE's row lock on the
                // same id deadlock across connections.
                await updateBasketStatus(Number(basketId), 'inProgress', conn);
            }
            await conn.commit();
            res.status(201).json({ id, userId, storeId, basketId: basketId ?? null });
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }
    } catch (error) {
        next(error);
    }
};

export const fetchShoppingListsByUserId = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = String(req.params.userId);
        const lists = await getShoppingListsByUserId(userId);
        res.json(lists);
    } catch (error) {
        next(error);
    }
};

export const fetchShoppingListById = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid shopping list ID' });
            return;
        }
        const list = await getShoppingListById(id);
        if (!list) {
            res.status(404).json({ error: 'Shopping list not found' });
            return;
        }
        res.json(list);
    } catch (error) {
        next(error);
    }
};

export const changeShoppingListStatus = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        const { status } = req.body;
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid shopping list ID' });
            return;
        }
        const validStatuses = ['active', 'completed'];
        if (!status || !validStatuses.includes(status)) {
            res.status(400).json({ error: 'Status must be active or completed' });
            return;
        }

        if (status === 'completed') {
            // Swipe-complete path (from the tab screen) doesn't tap each
            // item individually — user intent is "I'm done with this
            // list", so we align the data with that intent and auto-check
            // every unchecked item. Matches the on-detail-screen prompt
            // that already fires when everything's been ticked.
            await checkAllItemsByListId(id);
            await updateShoppingListStatus(id, status);
            const basketId = await getBasketIdByListId(id);
            if (basketId) await updateBasketStatus(basketId, 'completed');
        } else {
            // 'active' — used when reopening a completed list.
            await updateShoppingListStatus(id, status);
            const basketId = await getBasketIdByListId(id);
            if (basketId) await updateBasketStatus(basketId, 'inProgress');
        }

        res.json({ message: 'Status updated successfully' });
    } catch (error) {
        next(error);
    }
};

export const removeShoppingList = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid shopping list ID' });
            return;
        }

        const basketId = await getBasketIdByListId(id);
        await deleteShoppingList(id);

        // Revert basket to compared if it was inProgress (user abandoned
        // the trip mid-shop). If the list was completed, basket is already
        // terminal — no action.
        if (basketId) {
            const basket = await getBasketById(basketId);
            if (basket && basket.status === 'inProgress') {
                await updateBasketStatus(basketId, 'compared');
            }
        }

        res.status(204).send();
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/shopping-lists/:id/share
 * Body: { userId }
 *
 * Mints a short-lived share token for the list. Requires the caller to
 * already be a member of the list (prevents strangers from generating
 * share tokens for other people's lists).
 */
export const createListShareToken = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const listId = Number(req.params.id);
        const { userId } = req.body ?? {};
        if (isNaN(listId) || !userId) {
            res.status(400).json({ error: 'Invalid list ID or missing userId' });
            return;
        }
        if (!(await isShoppingListMember(listId, userId))) {
            res.status(403).json({ error: 'Not a member of this list' });
            return;
        }
        const { token, expiresAt } = await createShareToken(listId, userId);
        res.status(201).json({ token, expiresAt: expiresAt.toISOString() });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/shopping-lists/share/:token/status
 *
 * Polled by the creator-side QR modal every ~1.5s to detect a scan.
 * Returns one of three states:
 *   - pending: token is valid, not yet claimed → keep showing the QR
 *   - claimed: someone scanned → show the "Prisijungė" confirmation
 *   - expired: token past TTL → stop polling, close modal
 */
export const getShareTokenStatus = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const token = String(req.params.token);
        const row = await getShareTokenByToken(token);
        if (!row) {
            res.status(404).json({ error: 'Token not found' });
            return;
        }
        const expired = new Date(row.expiresAt).getTime() < Date.now();
        if (row.claimedAt) {
            res.json({ status: 'claimed', listId: row.listId, claimedBy: row.claimedBy });
            return;
        }
        if (expired) {
            res.json({ status: 'expired' });
            return;
        }
        res.json({ status: 'pending' });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/shopping-lists/share/:token/claim
 * Body: { userId }
 *
 * Scanner-side. Atomically:
 *   1. Flips the token to claimed (single-flight — concurrent claims
 *      beyond the first get 409).
 *   2. Inserts a ShoppingListMember row for the scanner (INSERT IGNORE
 *      so re-scanning your own list is a no-op rather than an error).
 * Returns { listId } on success so the client can navigate straight in.
 */
export const claimShareToken = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const token = String(req.params.token);
        const { userId } = req.body ?? {};
        if (!userId) {
            res.status(400).json({ error: 'Missing userId' });
            return;
        }
        const row = await getShareTokenByToken(token);
        if (!row) {
            res.status(404).json({ error: 'Token not found' });
            return;
        }
        // Self-claim short-circuit: if the user is the creator (or
        // already a member), just hand them the list id. No token
        // state change — keeps it live for the intended recipient.
        if (await isShoppingListMember(row.listId, userId)) {
            res.json({ listId: row.listId, alreadyMember: true });
            return;
        }
        const claimed = await markShareTokenClaimed(token, userId);
        if (!claimed) {
            // Either already claimed by someone else, or expired.
            const fresh = await getShareTokenByToken(token);
            const reason =
                fresh?.claimedAt ? 'already_claimed' :
                fresh && new Date(fresh.expiresAt).getTime() < Date.now() ? 'expired' :
                'unavailable';
            res.status(409).json({ error: 'Token cannot be claimed', reason });
            return;
        }
        await addShoppingListMember(row.listId, userId, 'member');
        res.json({ listId: row.listId });
    } catch (error) {
        next(error);
    }
};

/**
 * Duplicate a completed list into a fresh ACTIVE standalone copy. We
 * NULL-out basketId on the duplicate because the old basket is either
 * completed (terminal) or still in-progress with its own list — either
 * way the duplicate shouldn't claim it. Users who want to re-run a
 * calc can do that from the basket side.
 */
export const duplicateList = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        const { userId } = req.body;
        if (isNaN(id) || !userId) {
            res.status(400).json({ error: 'Invalid ID or missing userId' });
            return;
        }

        const newId = await duplicateShoppingList(id, userId);
        await duplicateListItems(id, newId);
        // Duplicates are standalone copies belonging to the duplicator,
        // not the original's co-members — single owner row, no bulk
        // member carry-over.
        await addShoppingListMember(newId, userId, 'owner');

        // Explicitly leave basketId = NULL on the duplicate (the model
        // already does this). This avoids reanimating a finished basket
        // or stealing another list's basket link.
        void updateShoppingListBasket; // kept imported for future paths

        res.json({ id: newId });
    } catch (error) {
        next(error);
    }
};
