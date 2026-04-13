import { Request, Response, NextFunction } from 'express';
import { createShoppingList, getShoppingListById, getShoppingListsByUserId, deleteShoppingList, updateShoppingListStatus } from '../models/shoppingListModel';

export const addShoppingList = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId, storeId } = req.body;
        if (!userId || !storeId) {
            res.status(400).json({ error: 'User ID and Store ID are required' });
            return;
        }
        const id = await createShoppingList(userId, storeId);
        res.status(201).json({ id, userId, storeId });
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
        await deleteShoppingList(id);
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
        const { duplicateShoppingList } = await import('../models/shoppingListModel');
        const { duplicateListItems } = await import('../models/shoppingListItemModel');
        const newId = await duplicateShoppingList(id, userId);
        await duplicateListItems(id, newId);
        res.json({ id: newId });
    } catch (error) {
        next(error);
    }
};