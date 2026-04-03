import { Request, Response, NextFunction } from 'express';
import { createListItem, getListItemsByShoppingListId, updateListItemQuantity, toggleListItem, deleteListItem } from '../models/shoppingListItemModel';

export const addListItem = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { listId, productId, quantity } = req.body;
        if (!listId || !productId || !quantity) {
            res.status(400).json({ error: 'All fields are required' });
            return;
        }
        const id = await createListItem(listId, productId, quantity);
        res.status(201).json({ id, listId, productId, quantity });
    } catch (error) {
        next(error);
    }
};

export const fetchListItemsByShoppingListId = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const listId = Number(req.params.listId);
        if (isNaN(listId)) {
            res.status(400).json({ error: 'Invalid shopping list ID' });
            return;
        }
        const items = await getListItemsByShoppingListId(listId);
        res.json(items);
    } catch (error) {
        next(error);
    }
};

export const updateListItem = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        const { quantity } = req.body;
        if (isNaN(id) || !quantity) {
            res.status(400).json({ error: 'Invalid ID or missing quantity' });
            return;
        }
        await updateListItemQuantity(id, quantity);
        res.json({ id, quantity });
    } catch (error) {
        next(error);
    }
};

export const toggleListItemChecked = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        const { isChecked } = req.body;
        if (isNaN(id) || typeof isChecked !== 'boolean') {
            res.status(400).json({ error: 'Invalid ID or missing isChecked value' });
            return;
        }
        await toggleListItem(id, isChecked);
        res.json({ id, isChecked });
    } catch (error) {
        next(error);
    }
};

export const removeListItem = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid ID' });
            return;
        }
        await deleteListItem(id);
        res.status(204).send();
    } catch (error) {
        next(error);
    }
};