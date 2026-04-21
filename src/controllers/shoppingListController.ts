import { Request, Response, NextFunction } from 'express';
import { createShoppingList, getShoppingListById, getShoppingListsByUserId, deleteShoppingList, updateShoppingListStatus, updateShoppingListBasket } from '../models/shoppingListModel.js';

export const addShoppingList = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId, storeId, basketId } = req.body;
        if (!userId || !storeId) {
            res.status(400).json({ error: 'User ID and Store ID are required' });
            return;
        }
        const id = await createShoppingList(userId, storeId, basketId || undefined);

        // Update basket status to active
        if (basketId) {
            const { updateBasketStatus } = await import('../models/basketModel.js');
            await updateBasketStatus(basketId, 'active');
        }

        res.status(201).json({ id, userId, storeId, basketId });
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
        await updateShoppingListStatus(id, status);

        if (status === 'completed') {
            const { checkAllItemsByListId } = await import('../models/shoppingListItemModel.js');
            await checkAllItemsByListId(id);

            const { getBasketIdByListId } = await import('../models/shoppingListModel.js');
            const basketId = await getBasketIdByListId(id);
            if (basketId) {
                const { updateBasketStatus } = await import('../models/basketModel.js');
                await updateBasketStatus(basketId, 'completed');
            }
        }
        // Update basket status if list is completed
        if (status === 'completed') {
            const { getBasketIdByListId } = await import('../models/shoppingListModel.js');
            const basketId = await getBasketIdByListId(id);
            if (basketId) {
                const { updateBasketStatus } = await import('../models/basketModel.js');
                await updateBasketStatus(basketId, 'completed');
            }
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

        // Get basketId before deleting
        const { getBasketIdByListId } = await import('../models/shoppingListModel.js');
        const basketId = await getBasketIdByListId(id);

        await deleteShoppingList(id);

        // Revert basket to compared if it was active
        if (basketId) {
            const { updateBasketStatus, getBasketById } = await import('../models/basketModel.js');
            const basket = await getBasketById(basketId);
            if (basket && basket.status === 'active') {
                await updateBasketStatus(basketId, 'compared');
            }
        }

        res.status(204).send();
    } catch (error) {
        next(error);
    }
};

export const duplicateList = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        const { userId } = req.body;
        if (isNaN(id) || !userId) {
            res.status(400).json({ error: 'Invalid ID or missing userId' });
            return;
        }
        const { duplicateShoppingList } = await import('../models/shoppingListModel.js');
        const { duplicateListItems } = await import('../models/shoppingListItemModel.js');
        const { getBasketIdByListId } = await import('../models/shoppingListModel.js');

        const basketId = await getBasketIdByListId(id);
        const newId = await duplicateShoppingList(id, userId);
        await duplicateListItems(id, newId);

        // Link to same basket and set it back to active
        if (basketId) {
            await updateShoppingListBasket(newId, basketId);
            const { updateBasketStatus } = await import('../models/basketModel.js');
            await updateBasketStatus(basketId, 'active');
        }

        res.json({ id: newId });
    } catch (error) {
        next(error);
    }
};