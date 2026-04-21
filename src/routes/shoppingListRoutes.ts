import { Router } from 'express';
import { addShoppingList, fetchShoppingListsByUserId, fetchShoppingListById, removeShoppingList, changeShoppingListStatus, duplicateList } from '../controllers/shoppingListController.js';

const router = Router();

/**
 * @swagger
 * /api/shopping-lists:
 *   post:
 *     summary: Create a new shopping list
 *     tags: [ShoppingList]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - storeId
 *             properties:
 *               userId:
 *                 type: string
 *                 format: uuid
 *                 example: 954b8b32-3976-4cb3-a3dd-5b035ec87d24
 *               storeId:
 *                 type: integer
 *                 example: 1
 *     responses:
 *       201:
 *         description: Shopping list created successfully
 */
// POST /api/shopping-lists - Create a new shopping list
router.post('/shopping-lists', addShoppingList);

/**
 * @swagger
 * /api/shopping-lists/user/{userId}:
 *   get:
 *     summary: Get all shopping lists for a user
 *     tags: [ShoppingList]
 *     parameters:
 *       - in: path
 *         name: userId
 *         schema:
 *           type: string
 *           format: uuid
 *         required: true
 *         description: The user ID
 *     responses:
 *       200:
 *         description: A list of shopping lists for the user
 */
// GET /api/shopping-lists/user/:userId - Get all shopping lists for a user
router.get('/shopping-lists/user/:userId', fetchShoppingListsByUserId);

/**
 * @swagger
 * /api/shopping-lists/{id}:
 *   get:
 *     summary: Get a single shopping list by ID
 *     tags: [ShoppingList]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: The shopping list ID
 *     responses:
 *       200:
 *         description: A single shopping list
 */
// GET /api/shopping-lists/:id - Get a single shopping list by ID
router.get('/shopping-lists/:id', fetchShoppingListById);

/**
 * @swagger
 * /api/shopping-lists/{id}:
 *   delete:
 *     summary: Delete a shopping list by ID
 *     tags: [ShoppingList]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: The shopping list ID
 *     responses:
 *       200:
 *         description: Shopping list deleted successfully
 */
// DELETE /api/shopping-lists/:id - Delete a shopping list by ID
router.delete('/shopping-lists/:id', removeShoppingList);

router.patch('/shopping-lists/:id/status', changeShoppingListStatus);

router.post('/shopping-lists/:id/duplicate', duplicateList);
export default router;