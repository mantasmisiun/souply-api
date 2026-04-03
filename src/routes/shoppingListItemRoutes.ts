import { Router } from 'express';
import { addListItem, fetchListItemsByShoppingListId, updateListItem, toggleListItemChecked, removeListItem } from '../controllers/shoppingListItemController';

const router = Router();

// POST /api/list-items - Add an item to a shopping list
router.post('/list-items', addListItem);

// GET /api/shopping-lists/:listId/items - Get all items in a shopping list
router.get('/shopping-lists/:listId/items', fetchListItemsByShoppingListId);

// PUT /api/list-items/:id - Update the quantity of a shopping list item
router.put('/list-items/:id', updateListItem);

// PATCH /api/list-items/:id/toggle - Toggle the checked status of a shopping list item
router.patch('/list-items/:id/toggle', toggleListItemChecked);

// DELETE /api/list-items/:id - Remove an item from a shopping list
router.delete('/list-items/:id', removeListItem);

export default router;