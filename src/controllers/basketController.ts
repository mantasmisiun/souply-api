import { Request, Response, NextFunction } from 'express';
import { createBasket, getBasketsByUserId, getBasketById, updateBasketUpdatedAt, updateBasketStatus, deleteBasket, updateBasketName, getUserDraftBasketId } from '../models/basketModel.js';

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
        const opts = {
            lat: Number.isFinite(rawLat) ? rawLat : undefined,
            lng: Number.isFinite(rawLng) ? rawLng : undefined,
        };

        const { calculateBasketForStores } = await import('../services/basketCalculationService.js');
        const results = await calculateBasketForStores(id, opts);
        await updateBasketStatus(id, 'compared');
        res.json(results);
    } catch (error) {
        next(error);
    }
};