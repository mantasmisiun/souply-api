import { Request, Response, NextFunction } from 'express';
import { createListItem, getListItemsByShoppingListId, updateListItemQuantity, toggleListItem, deleteListItem, getListItemByListAndProduct } from '../models/shoppingListItemModel.js';

export const addListItem = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { listId, productId, storeProductId, quantity, price, name } = req.body;
        // productId is OPTIONAL — null is valid for custom/manual items
        // added via the inline quick-add input. Only listId and quantity
        // are truly required.
        if (!listId || quantity === undefined || quantity === null) {
            res.status(400).json({ error: 'listId and quantity are required' });
            return;
        }

        // Catalog-sourced items (productId !== null) dedup by productId
        // on the same list: adding the same product twice bumps the
        // existing row's quantity. Custom items (productId === null) are
        // always treated as distinct inserts — their only identity is
        // the row id, so we can't merge them sensibly.
        if (productId !== null && productId !== undefined) {
            const existingItem = await getListItemByListAndProduct(listId, productId);
            if (existingItem) {
                const newQuantity = parseFloat(existingItem.quantity) + parseFloat(quantity);
                await updateListItemQuantity(existingItem.id, newQuantity);
                res.json({ id: existingItem.id, listId, productId, quantity: newQuantity });
                return;
            }
        }
        const id = await createListItem(
            listId,
            productId ?? null,
            storeProductId ?? null,
            quantity,
            price ?? null,
            name ?? null
        );
        res.status(201).json({ id, listId, productId: productId ?? null, storeProductId: storeProductId ?? null, quantity, price: price ?? null });
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