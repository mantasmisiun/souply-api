import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import { ensureTripForBasket } from '../services/tripLinkService.js';
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
        // New basket owned by the token subject (the source is owner-checked by middleware).
        const userId = req.authUserId;
        if (!Number.isFinite(sourceId) || !userId) {
            res.status(400).json({ error: 'auth and basket id are required' });
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
            await ensureTripForBasket(newId, userId, conn);
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
        const userId = req.authUserId; // token subject; body userId ignored
        if (!userId) {
            res.status(401).json({ error: 'auth-required' });
            return;
        }
        // Idempotent behaviour: if the user already has a draft basket,
        // return it instead of minting a duplicate. This closes the race
        // where two "add to basket" taps from different screens each fire
        // a create request before either has updated the client's cached
        // draftBasketId. The frontend still serializes creates via an
        // in-flight promise (basketUtils.ts), but this is the backstop.
        //
        // `forceNew` opts OUT of the idempotency: the user EXPLICITLY chose
        // "new basket" in the chooser, so we mint a fresh draft even when one
        // exists. The previous draft is kept (offered as its own chooser row
        // until it ages out) — multiple concurrent personal drafts are allowed
        // in the 2.0 chooser model.
        const forceNew = req.body?.forceNew === true;
        if (!forceNew) {
            const existing = await getUserDraftBasketId(userId);
            if (existing !== null) {
                res.status(200).json({ id: existing, userId, existing: true });
                return;
            }
        }
        const id = await createBasket(userId);
        // 2.0: every basket lives inside a trip from birth (idempotent).
        await ensureTripForBasket(id, userId);
        res.status(201).json({ id, userId, existing: false });
    } catch (error) {
        next(error);
    }
};

export const fetchBasketsByUserId = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = String(req.params.userId);
        const baskets = await getBasketsByUserId(userId, req.locale);
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
            // Viewer → enables the PERSONAL merge tier. Falls back to the basket
            // owner inside the service when absent (anon requests).
            userId: req.authUserId,
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

// ── On-demand per-store basket pricing ─────────────────────────────────────
// Lazily price the basket at SPECIFIC stores — powers the map's "tap a pin to
// price it" and the capped "calculate this area" batch. Reuses the same
// calculateBasketForStores engine as /calculate (identical result shape), but:
//   • takes an explicit, small storeIds list (capped) instead of top-N,
//   • is READ-ONLY — never flips basket status or persists a cheapest total,
//   • memoises per (basket version × user location × store) so re-taps and
//     revisits within a results session are free and the engine isn't re-run.
const STORE_PRICE_CACHE = new Map<string, { ts: number; result: any }>();
const STORE_PRICE_TTL_MS = 2 * 60 * 60 * 1000; // 2h — a results session
const STORE_PRICE_MAX_IDS = 10;                 // matches the client's batch cap

export const getBasketStorePrices = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) { res.status(400).json({ error: 'Invalid basket ID' }); return; }
        const basket = await getBasketById(id);
        if (!basket) { res.status(404).json({ error: 'Basket not found' }); return; }

        const rawStoreIds = req.body?.storeIds;
        const storeIds: number[] = Array.isArray(rawStoreIds)
            ? Array.from(new Set(rawStoreIds.map(Number).filter((n: number) => n > 0 && Number.isFinite(n)))).slice(0, STORE_PRICE_MAX_IDS)
            : [];
        if (storeIds.length === 0) { res.status(400).json({ error: 'storeIds required (1-10)' }); return; }

        const rawLat = Number(req.body?.lat);
        const rawLng = Number(req.body?.lng);
        const lat = Number.isFinite(rawLat) ? rawLat : undefined;
        const lng = Number.isFinite(rawLng) ? rawLng : undefined;

        // Cache version: a basket edit (updatedAt) AND the user's location
        // (rounded to ~100 m) both bust the cache — either can change a store's
        // result (price / distance).
        const ver = (basket as any).updatedAt ? new Date((basket as any).updatedAt).getTime() : 0;
        const locKey = `${lat != null ? lat.toFixed(3) : '_'}:${lng != null ? lng.toFixed(3) : '_'}`;
        const keyOf = (sid: number) => `${id}:${ver}:${locKey}:${sid}`;

        const now = Date.now();
        const cached: any[] = [];
        const toCompute: number[] = [];
        for (const sid of storeIds) {
            const hit = STORE_PRICE_CACHE.get(keyOf(sid));
            if (hit && now - hit.ts < STORE_PRICE_TTL_MS) cached.push(hit.result);
            else toCompute.push(sid);
        }

        let computed: any[] = [];
        if (toCompute.length) {
            const { calculateBasketForStores } = await import('../services/basketCalculationService.js');
            computed = await calculateBasketForStores(id, { storeIds: toCompute, lat, lng, userId: req.authUserId }) as any[];
            for (const r of computed) {
                const sid = Number(r?.storeId);
                if (sid > 0) STORE_PRICE_CACHE.set(keyOf(sid), { ts: now, result: r });
            }
            // Lazy sweep so the cache can't grow unbounded across baskets.
            if (STORE_PRICE_CACHE.size > 10000) {
                for (const [k, v] of STORE_PRICE_CACHE) {
                    if (now - v.ts >= STORE_PRICE_TTL_MS) STORE_PRICE_CACHE.delete(k);
                }
            }
        }

        res.json([...cached, ...computed]);
    } catch (error) {
        next(error);
    }
};