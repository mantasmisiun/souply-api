import { Request, Response, NextFunction } from 'express';
import { createBasketItem, getBasketItemById, getBasketItemsByBasketId, updateBasketItemQuantity, deleteBasketItem, getBasketItemByBasketAndProduct } from '../models/basketItemModel.js';
import { getProductById } from '../models/productModel.js';
import { getBasketById } from '../models/basketModel.js';

export const addBasketItem = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { basketId, productId, quantity } = req.body;
        if (!basketId || !productId || quantity === undefined || quantity === null) {
            res.status(400).json({ error: 'All fields are required' });
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

        const product = await getProductById(productId);
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

        // Get basket item to find basketId
        const basketItem = await getBasketItemById(id);
        if (!basketItem) {
            res.status(404).json({ error: 'Basket item not found' });
            return;
        }

        // Check basket status
        const basket = await getBasketById(basketItem.basketId);
        if (!basket) {
            res.status(404).json({ error: 'Basket not found' });
            return;
        }
        if (basket.status !== 'draft') {
            res.status(400).json({ error: 'Cannot modify a basket that is not in draft status' });
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