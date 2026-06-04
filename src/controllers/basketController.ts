import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import { createBasket, getBasketsByUserId, getBasketById, updateBasketUpdatedAt, updateBasketStatus, updateBasketSavedAmount, deleteBasket, updateBasketName, getUserDraftBasketId, markBasketCalculated, updateBasketCheapestTotal } from '../models/basketModel.js';
import { copiedSourceTemplateId } from '../util/basketCopy.js';

/**
 * POST /api/baskets/:id/copy  Body: { userId }
 * Clones a basket's items into a new draft basket. If the source basket was
 * edited (diverged from the creator's original), the copy is "plain" — no
 * template link, so it loses the inherited emoji/colour/@attribution and the
 * user can name it / save it as a template. An unedited basket's copy keeps
 * the template link (stays identical to the original).
 */
export const copyBasket = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const sourceId = Number(req.params.id);
        const { userId } = req.body ?? {};
        if (!Number.isFinite(sourceId) || !userId) {
            res.status(400).json({ error: 'Basket id and userId are required' });
            return;
        }
        const source = await getBasketById(sourceId);
        if (!source) { res.status(404).json({ error: 'Basket not found' }); return; }

        const newSourceTemplateId = copiedSourceTemplateId(
            source.sourceTemplateId ?? null,
            source.userEditedAfterCreation === 1,
        );

        const conn = await (pool as any).getConnection();
        try {
            await conn.beginTransaction();
            const newId = await createBasket(userId, newSourceTemplateId, conn);
            const [items]: any = await conn.query(
                `SELECT productId, quantity, matchMode, anchorAmount, anchorUnit FROM BasketItem WHERE basketId = ?`,
                [sourceId],
            );
            if (items.length > 0) {
                const values = items.map((it: any) => [
                    newId, it.productId, it.quantity, it.matchMode ?? 'sku',
                    it.anchorAmount ?? null, it.anchorUnit ?? null,
                ]);
                await conn.query(
                    `INSERT INTO BasketItem (basketId, productId, quantity, matchMode, anchorAmount, anchorUnit) VALUES ?`,
                    [values],
                );
            }
            await conn.commit();
            res.status(201).json({ id: newId, userId, itemCount: items.length });
        } catch (e) {
            try { await conn.rollback(); } catch {}
            throw e;
        } finally {
            conn.release();
        }
    } catch (error) {
        next(error);
    }
};

export const addBasket = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId } = req.body;
        if (!userId) {
            res.status(400).json({ error: 'User ID is required' });
            return;
        }
        // Idempotent behaviour: if the user already has a draft basket,
        // return it instead of minting a duplicate. This closes the race
        // where two "add to basket" taps from different screens each fire
        // a create request before either has updated the client's cached
        // draftBasketId. The frontend still serializes creates via an
        // in-flight promise (basketUtils.ts), but this is the backstop.
        const existing = await getUserDraftBasketId(userId);
        if (existing !== null) {
            res.status(200).json({ id: existing, userId, existing: true });
            return;
        }
        const id = await createBasket(userId);
        res.status(201).json({ id, userId, existing: false });
    } catch (error) {
        next(error);
    }
};

export const fetchBasketsByUserId = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = String(req.params.userId);
        const baskets = await getBasketsByUserId(userId);
        res.json(baskets);
    } catch (error) {
        next(error);
    }
};

export const fetchBasketById = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid basket ID' });
            return;
        }
        const basket = await getBasketById(id);
        if (!basket) {
            res.status(404).json({ error: 'Basket not found' });
            return;
        }
        res.json(basket);
    } catch (error) {
        next(error);
    }
};

export const updateBasket = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid basket ID' });
            return;
        }
        const basket = await getBasketById(id);
        if (!basket) {
            res.status(404).json({ error: 'Basket not found' });
            return;
        }
        await updateBasketUpdatedAt(id);
        res.json({ message: 'Basket updated successfully' });
    } catch (error) {
        next(error);
    }
};

export const changeBasketStatus = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        const { status } = req.body;
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid basket ID' });
            return;
        }
        const validStatuses = ['draft', 'compared', 'inProgress', 'completed'];
        if (!status || !validStatuses.includes(status)) {
            res.status(400).json({ error: 'Status must be draft, compared, inProgress or completed' });
            return;
        }
        const basket = await getBasketById(id);
        if (!basket) {
            res.status(404).json({ error: 'Basket not found' });
            return;
        }
        await updateBasketStatus(id, status);
        res.json({ message: 'Basket status updated successfully' });
    } catch (error) {
        next(error);
    }
};

export const removeBasket = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid basket ID' });
            return;
        }
        const basket = await getBasketById(id);
        if (!basket) {
            res.status(404).json({ error: 'Basket not found' });
            return;
        }
        await deleteBasket(id);
        res.json({ message: 'Basket deleted successfully' });
    } catch (error) {
        next(error);
    }
};

export const renameBasket = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        const { name } = req.body;
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid basket ID' });
            return;
        }
        if (!name || typeof name !== 'string') {
            res.status(400).json({ error: 'Name is required' });
            return;
        }
        const basket = await getBasketById(id);
        if (!basket) {
            res.status(404).json({ error: 'Basket not found' });
            return;
        }
        await updateBasketName(id, name);
        res.json({ message: 'Basket renamed successfully' });
    } catch (error) {
        next(error);
    }
};

// This endpoint will trigger price comparison for the basket and update its status to 'compared'
export const calculateBasket = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid basket ID' });
            return;
        }
        const basket = await getBasketById(id);
        if (!basket) {
            res.status(404).json({ error: 'Basket not found' });
            return;
        }
        // Accept user coordinates from body. Frontend gets them from
        // expo-location, or from the address-modal → /api/geocode flow.
        // Service falls back to Vilnius centre if absent.
        const rawLat = Number(req.body?.lat);
        const rawLng = Number(req.body?.lng);
        const rawStoreIds = req.body?.storeIds;
        const opts = {
            lat: Number.isFinite(rawLat) ? rawLat : undefined,
            lng: Number.isFinite(rawLng) ? rawLng : undefined,
            storeIds: Array.isArray(rawStoreIds)
                ? rawStoreIds.map(Number).filter((n: number) => n > 0 && Number.isFinite(n))
                : undefined,
        };

        const { calculateBasketForStores } = await import('../services/basketCalculationService.js');
        const results = await calculateBasketForStores(id, opts);
        await updateBasketStatus(id, 'compared');
        // Lifetime fact: this basket has been through the comparison engine
        // at least once. Drives the abandonment-detection query used by
        // the template instantiate endpoint and the daily cleanup cron.
        await markBasketCalculated(id);
        // Persist the cheapest store's total so the Krepselis card can
        // show "nuo €X" for compared baskets without re-running the
        // comparison engine on every list load. Drops missing-items
        // stores first (they're not actionable), then picks the lowest
        // total — matches what the client's results screen highlights.
        const cheapest = (results as any[])
            .filter(r => r && Array.isArray(r.missingItemNames) && r.missingItemNames.length === 0 && Number.isFinite(Number(r.total)))
            .reduce<number | null>((acc, r) => {
                const t = Number(r.total);
                return acc == null || t < acc ? t : acc;
            }, null);
        await updateBasketCheapestTotal(id, cheapest != null ? Number(cheapest.toFixed(2)) : null);
        res.json(results);
    } catch (error) {
        next(error);
    }
};