import { Router } from 'express';
import { addShoppingList, fetchShoppingListsByUserId, fetchShoppingListById, removeShoppingList } from '../controllers/shoppingListController';

const router = Router();

// POST /api/shopping-lists - Create a new shopping list
router.post('/shopping-lists', addShoppingList);

// GET /api/shopping-lists/user/:userId - Get all shopping lists for a user
router.get('/shopping-lists/user/:userId', fetchShoppingListsByUserId);

// GET /api/shopping-lists/:id - Get a single shopping list by ID
router.get('/shopping-lists/:id', fetchShoppingListById);

// DELETE /api/shopping-lists/:id - Delete a shopping list by ID
router.delete('/shopping-lists/:id', removeShoppingList);

export default router;