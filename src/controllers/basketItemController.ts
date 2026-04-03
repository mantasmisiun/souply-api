import { Request, Response, NextFunction } from 'express';
import { createBasketItem, getBasketItemsByBasketId, updateBasketItemQuantity, deleteBasketItem } from '../models/basketItemModel';

export const addBasketItem = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { basketId, productId, quantity } = req.body;
        if (!basketId || !productId || !quantity) {
            res.status(400).json({ error: 'All fields are required' });
            return;
        }
        const id = await createBasketItem(basketId, productId, quantity);
        res.status(201).json({ id, basketId, productId, quantity });
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
        const items = await getBasketItemsByBasketId(basketId);
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
        await updateBasketItemQuantity(id, quantity);
        res.json({ id, quantity });
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
        await deleteBasketItem(id);
        res.status(204).send();
    } catch (error) {
        next(error);
    }
};