import { Request, Response, NextFunction } from 'express';
import { ensureTripForList, relinkReceiptToListTrip } from '../services/tripLinkService.js';
import pool from '../config/db.js';
import {
    createShoppingList,
    getShoppingListById,
    getShoppingListsByUserId,
    deleteShoppingList,
    updateShoppingListStatus,
    updateShoppingListBasket,
    getShoppingListByBasketId,
    getShoppingListByBasketAndStore,
    getBasketIdByListId, allBasketListsCompleted,
    duplicateShoppingList,
    linkReceiptToList,
} from '../models/shoppingListModel.js';
import {
    createListItemsBatch,
    checkAllItemsByListId,
    duplicateListItems,
} from '../models/shoppingListItemModel.js';
import { getBasketById, updateBasketStatus } from '../models/basketModel.js';
import { addCollectiveSavings, incrementTemplateUseCount, getTemplateById, recordTemplateEngagementOncePerDay } from '../models/basketTemplateModel.js';
import { addShoppingListMember, isShoppingListMember } from '../models/shoppingListMemberModel.js';
import {
    createShareToken,
    getShareTokenByToken,
    markShareTokenClaimed,
} from '../models/shoppingListShareTokenModel.js';
import { getBasketOwnerId } from '../models/basketModel.js';
import { getReceiptOwnerId } from '../models/receiptModel.js';

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
        const { storeId, basketId, items, savingsEur } = req.body ?? {};
        const userId = req.authUserId; // token subject; body userId ignored
        if (!userId) {
            res.status(401).json({ error: 'auth-required' });
            return;
        }
        if (!storeId) {
            res.status(400).json({ error: 'Store ID is required' });
            return;
        }
        if (items !== undefined && !Array.isArray(items)) {
            res.status(400).json({ error: 'items must be an array' });
            return;
        }
        // When creating a list FROM a basket, the caller must own that basket — otherwise
        // supplying someone else's basketId flips their basket to 'inProgress' and reads
        // its template. (The list routes have no basket-owner middleware; check inline.)
        if (basketId) {
            const basketOwner = await getBasketOwnerId(Number(basketId));
            if (basketOwner !== null && basketOwner !== userId) {
                res.status(403).json({ error: 'forbidden' });
                return;
            }
        }

        // Duplicate-per-basket guard. The DB also enforces this, but a
        // friendly 409 with the existing list id lets the UI route users
        // to the existing list instead of popping a raw error.
        // `firstListForBasket` is captured here (before the insert) so the
        // template "use" + savings accrue exactly ONCE per basket — split
        // combos create one list per store, and only the first should count.
        let firstListForBasket = false;
        if (basketId) {
            firstListForBasket = !(await getShoppingListByBasketId(Number(basketId)));
            // Check per (basketId, storeId) — split combos create one list per store.
            const existing = await getShoppingListByBasketAndStore(Number(basketId), Number(storeId));
            if (existing) {
                res.status(409).json({
                    error: 'A shopping list already exists for this basket at this store',
                    listId: existing.id,
                });
                return;
            }
        }

        const conn = await (pool as any).getConnection();
        try {
            await conn.beginTransaction();
            const id = await createShoppingList(userId, storeId, basketId ?? null, conn);
            // 2.0: the list joins its basket's trip (a split's rows share it)
            // or mints its own when standalone.
            await ensureTripForList(id, userId, basketId ?? null, conn);
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

                // First shopping list for this basket → count the template
                // "use" (Panaudojimai) and accrue the realised savings
                // (Padėjai sutaupyti), exactly once per basket. savingsEur =
                // average of the UNIQUE full-coverage store totals − the chosen
                // store, computed client-side from the comparison the user saw.
                if (firstListForBasket) {
                    const basket = await getBasketById(Number(basketId));
                    if (basket?.sourceTemplateId) {
                        const templateId = Number(basket.sourceTemplateId);
                        const template = await getTemplateById(templateId);
                        // Anti-inflation: never count a creator's own use of their
                        // template, and count any user's use at most once per day
                        // (a genuine weekly shopper still adds ~1/week). Savings
                        // stay on the existing per-basket logic, just skipped for
                        // self-use too.
                        const isSelfUse = !template || template.userId === userId;
                        const firstUseToday = !isSelfUse
                            && await recordTemplateEngagementOncePerDay(templateId, String(userId), 'use', conn);
                        if (firstUseToday) {
                            await incrementTemplateUseCount(templateId, conn);
                        }
                        const savings = Number(savingsEur);
                        if (!isSelfUse && Number.isFinite(savings) && savings > 0) {
                            // Anti-tamper cap: a realised saving can't exceed the
                            // basket's own value (Σ chosen-store item prices).
                            const basketValue = Array.isArray(items)
                                ? items.reduce((s: number, it: any) =>
                                    s + (Number(it.price) || 0) * (Number(it.quantity) || 0), 0)
                                : 0;
                            const capped = basketValue > 0 ? Math.min(savings, basketValue) : savings;
                            await addCollectiveSavings(templateId, capped, conn);
                        }
                    }
                }
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
            // SPLIT-SAFE: a 2/3-store basket completes only when EVERY store's
            // list is completed — completing the FIRST store used to mark the
            // whole basket terminal while the other store was still shoppable.
            if (basketId && (await allBasketListsCompleted(basketId))) {
                await updateBasketStatus(basketId, 'completed');
            }
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

/**
 * POST /api/shopping-lists/:id/link-receipt
 * Body: { receiptId }
 *
 * Link an uploaded/scanned Receipt to the completed list row (the store
 * trip it covers). Sets Receipt.shoppingListId. Used both by the
 * post-completion upload flow and the duplicate silent-link path (a
 * re-photographed receipt already in the DB is pointed at the list
 * instead of inserting a new row).
 */
export const linkReceiptToShoppingList = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        const receiptId = Number(req.body?.receiptId);
        if (!Number.isFinite(id) || !Number.isFinite(receiptId)) {
            res.status(400).json({ error: 'Valid list id and receiptId are required' });
            return;
        }
        const list = await getShoppingListById(id);
        if (!list) {
            res.status(404).json({ error: 'Shopping list not found' });
            return;
        }
        // List membership is already enforced by middleware; ALSO require the caller to own
        // the receipt they're attaching, so a member can't link someone else's receipt.
        const receiptOwner = await getReceiptOwnerId(receiptId);
        if (receiptOwner === null) {
            res.status(404).json({ error: 'Receipt not found' });
            return;
        }
        if (receiptOwner !== req.authUserId) {
            res.status(403).json({ error: 'forbidden' });
            return;
        }
        await linkReceiptToList(receiptId, id);
        // 2.0: move the receipt onto the LIST's trip (dropping the churn
        // ad-hoc trip the bare upload may have minted seconds earlier).
        await relinkReceiptToListTrip(receiptId, id);
        res.json({ success: true });
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
        const userId = req.authUserId; // token subject
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
        const userId = req.authUserId; // token subject
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
        const userId = req.authUserId; // token subject
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


/**
 * Souply 2.0 per-store mini-cycles — "Nepirkau čia": close a completed
 * slot WITHOUT a receipt (stage derivation treats skipped slots as closed,
 * so skipping the last open slot moves the trip to stage 5). Unskip
 * reopens the slot (the user found the receipt after all).
 */
export const skipListReceipt = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        await pool.query('UPDATE ShoppingList SET receiptSkippedAt = NOW() WHERE id = ? AND receiptSkippedAt IS NULL', [id]);
        res.json({ id, receiptSkipped: true });
    } catch (error) { next(error); }
};

export const unskipListReceipt = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        await pool.query('UPDATE ShoppingList SET receiptSkippedAt = NULL WHERE id = ?', [id]);
        res.json({ id, receiptSkipped: false });
    } catch (error) { next(error); }
};
