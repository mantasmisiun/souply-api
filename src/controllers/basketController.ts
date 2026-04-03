import { Request, Response, NextFunction } from 'express';
import { createBasket, getBasketsByUserId, getBasketById, updateBasketUpdatedAt, updateBasketStatus, deleteBasket } from '../models/basketModel';

export const addBasket = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId } = req.body;
        if (!userId) {
            res.status(400).json({ error: 'User ID is required' });
            return;
        }
        const id = await createBasket(userId);
        res.status(201).json({ id, userId });
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
        const validStatuses = ['draft', 'compared', 'completed'];
        if (!status || !validStatuses.includes(status)) {
            res.status(400).json({ error: 'Status must be draft, compared or completed' });
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