import { Request, Response, NextFunction } from 'express';
import { createBasketItem, getBasketItemById, getBasketItemsByBasketId, updateBasketItemQuantity, deleteBasketItem, getBasketItemByBasketAndProduct, convertBasketItemsMode } from '../models/basketItemModel.js';
import { getProductById } from '../models/productModel.js';
import { getBasketById, updateBasketUpdatedAt, markBasketUserEdited, updateBasketStatus } from '../models/basketModel.js';
import { logInteraction } from '../models/productInteractionModel.js';

/**
 * EDIT GATE for a basket's items. A 'compared' basket is one we have PRICED, not
 * one that is finished — editing it is normal (the user adds a forgotten item
 * after seeing the store results), it just invalidates those results. So editing
 * REVERTS it to 'draft' rather than being refused.
 *
 * This used to reject anything non-draft, and only the basket-detail screen knew
 * to call its own revertToDraftIfCompared() first. Every other entry point (the
 * catalog card + amount modal, product detail, search, the session dock) hit a
 * silent 400: the spinner ran, the item never landed, the button fell back to
 * "Add". Enforcing the rule HERE — the one choke point all of them share — fixes
 * every path at once instead of duplicating the revert into each surface.
 *
 * 'inProgress' / 'completed' stay refused: those have shopping lists or receipts
 * hanging off them, so mutating their items really would corrupt state.
 *
 * Returns `reverted` so the response can tell the client its cached price
 * results for this basket are now stale.
 */
type EditGate = { ok: true; reverted: boolean } | { ok: false; status: number; error: string };

export const ensureBasketEditable = async (basketId: number): Promise<EditGate> => {
    const basket = await getBasketById(basketId);
    if (!basket) return { ok: false, status: 404, error: 'Basket not found' };
    if (basket.status === 'draft') return { ok: true, reverted: false };
    if (basket.status === 'compared') {
        await updateBasketStatus(basketId, 'draft');
        return { ok: true, reverted: true };
    }
    return { ok: false, status: 400, error: 'Cannot modify a basket that is not in draft status' };
};

export const addBasketItem = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { basketId, productId, quantity, matchMode } = req.body;
        if (!basketId || !productId || quantity === undefined || quantity === null) {
            res.status(400).json({ error: 'All fields are required' });
            return;
        }
        // Accept 'base' or 'sku'; fall back to 'sku' for clients that don't
        // yet send the field (pre-Phase-1 app builds). Never throw on a
        // missing/weird value — the flag is a pricing hint, not auth.
        const resolvedMatchMode: 'sku' | 'base' =
            matchMode === 'base' ? 'base' : 'sku';

        const basket = await getBasketById(basketId);
        if (!basket) {
            res.status(404).json({ error: 'Basket not found' });
            return;
        }
        const gate = await ensureBasketEditable(basketId);
        if (!gate.ok) {
            res.status(gate.status).json({ error: gate.error });
            return;
        }

        const product = await getProductById(productId, req.locale);
        if (!product) {
            res.status(404).json({ error: 'Product not found' });
            return;
        }

        // Check if product already exists in basket
        const existingItem = await getBasketItemByBasketAndProduct(basketId, productId);
        if (existingItem) {
            res.status(409).json({ error: 'Product already in basket' });
            return;
        }

        const id = await createBasketItem(basketId, productId, quantity, resolvedMatchMode);
        await updateBasketUpdatedAt(basketId);
        // Flip the abandonment flag — once a user has added even one item,
        // the basket is no longer "untouched template instance".
        await markBasketUserEdited(basketId);
        logInteraction(basket.userId, productId, 'basket_add').catch(() => {});
        // `revertedToDraft` → the client drops its cached price results for this
        // basket; they were computed before this item existed.
        res.status(201).json({ id, basketId, productId, quantity, matchMode: resolvedMatchMode, revertedToDraft: gate.reverted });
    } catch (error) {
        next(error);
    }
};

export const fetchBasketItemsByBasketId = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const basketId = Number(req.params.basketId);
        if (isNaN(basketId)) {
            res.status(400).json({ error: 'Invalid basket ID' });
            return;
        }
        const basket = await getBasketById(basketId);
        const items = await getBasketItemsByBasketId(basketId, basket?.userId ?? null, req.locale);
        res.json(items);
    } catch (error) {
        next(error);
    }
};

export const updateBasketItem = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        const { quantity } = req.body;
        if (isNaN(id) || !quantity) {
            res.status(400).json({ error: 'Invalid ID or missing quantity' });
            return;
        }

        // Get basket item to find basketId
        const basketItem = await getBasketItemById(id);
        if (!basketItem) {
            res.status(404).json({ error: 'Basket item not found' });
            return;
        }

        // Editing quantity is an edit like any other — a priced basket reverts.
        const gate = await ensureBasketEditable(basketItem.basketId);
        if (!gate.ok) {
            res.status(gate.status).json({ error: gate.error });
            return;
        }

        await updateBasketItemQuantity(id, quantity);
        await updateBasketUpdatedAt(basketItem.basketId);
        await markBasketUserEdited(basketItem.basketId);
        res.json({ id, quantity, revertedToDraft: gate.reverted });
    } catch (error) {
        next(error);
    }
};

export const removeBasketItem = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid ID' });
            return;
        }
        // Look up the row before deleting so we know which basket to bump.
        const basketItem = await getBasketItemById(id);
        if (basketItem) {
            // Removing an item from a priced basket reverts it too — otherwise the
            // stored results would price a line the basket no longer holds.
            const gate = await ensureBasketEditable(basketItem.basketId);
            if (!gate.ok) {
                res.status(gate.status).json({ error: gate.error });
                return;
            }
        }
        await deleteBasketItem(id);
        if (basketItem) {
            await updateBasketUpdatedAt(basketItem.basketId);
            await markBasketUserEdited(basketItem.basketId);
        }
        res.status(204).send();
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/baskets/:basketId/convert-mode
 * Body: { mode: 'base' | 'sku' }
 *
 * Converts every BasketItem in the basket to the target mode. On sku→base
 * duplicates collapse (same cluster head) and quantities sum. On base→sku
 * matchMode flips in-place (productId already points at head). Only valid
 * on draft baskets; calculated/ordered baskets are immutable.
 */
export const convertBasketMode = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const basketId = Number(req.params.basketId);
        if (isNaN(basketId)) {
            res.status(400).json({ error: 'Invalid basket ID' });
            return;
        }
        const target = req.body?.mode === 'base' ? 'base' : req.body?.mode === 'sku' ? 'sku' : null;
        if (!target) {
            res.status(400).json({ error: 'mode must be "base" or "sku"' });
            return;
        }

        const basket = await getBasketById(basketId);
        if (!basket) {
            res.status(404).json({ error: 'Basket not found' });
            return;
        }
        if (basket.status !== 'draft') {
            res.status(400).json({ error: 'Cannot modify a basket that is not in draft status' });
            return;
        }

        const result = await convertBasketItemsMode(basketId, target);
        await updateBasketUpdatedAt(basketId);
        res.json({ ok: true, mode: target, ...result });
    } catch (error) {
        next(error);
    }
};