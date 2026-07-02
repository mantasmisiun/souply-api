import { Router } from 'express';
import { addListItem, fetchListItemsByShoppingListId, updateListItem, toggleListItemChecked, removeListItem } from '../controllers/shoppingListItemController.js';
import { requireUser } from '../middleware/sessionAuth.js';
import { requireListMember, requireListMemberFromBody, requireListItemMember } from '../middleware/resourceAuth.js';

// List items are collaborative — any MEMBER of the parent list may add/read/edit/toggle/
// remove (matches the shared-list model). POST reads listId from the body; item :id routes
// resolve item→parent list → membership.

const router = Router();

/**
 * @swagger
 * /api/list-items:
 *   post:
 *     summary: Add an item to a shopping list
 *     tags: [ShoppingListItem]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - listId
 *               - productId
 *               - quantity
 *             properties:
 *               listId:
 *                 type: integer
 *                 example: 1
 *               productId:
 *                 type: integer
 *                 example: 1
 *               quantity:
 *                 type: number
 *     responses:
 *       201:
 *         description: Shopping list item added successfully
 */
// POST /api/list-items - Add an item to a shopping list
router.post('/list-items', requireUser, requireListMemberFromBody('listId'), addListItem);

/**
 * @swagger
 * /api/shopping-lists/{listId}/items:
 *   get:
 *     summary: Get all items in a shopping list
 *     tags: [ShoppingListItem]
 *     parameters:
 *       - in: path
 *         name: listId
 *         schema:
 *           type: integer
 *         required: true
 *         description: The shopping list ID
 *     responses:
*       200:
*         description: A list of items in the shopping list
 */
// GET /api/shopping-lists/:listId/items - Get all items in a shopping list
router.get('/shopping-lists/:listId/items', requireUser, requireListMember('listId'), fetchListItemsByShoppingListId);

/**
 * @swagger
 * /api/list-items/{id}:
 *   put:
 *     summary: Update the quantity of a shopping list item
 *     tags: [ShoppingListItem]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: The shopping list item ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - quantity
 *             properties:
 *               quantity:
 *                 type: integer
 *                 minimum: 1
 *     responses:
 *       200:
 *         description: Shopping list item updated successfully
 */
// PUT /api/list-items/:id - Update the quantity of a shopping list item
router.put('/list-items/:id', requireUser, requireListItemMember('id'), updateListItem);

/**
 * @swagger
 * /api/list-items/{id}/toggle:
 *   patch:
 *     summary: Toggle the checked status of a shopping list item
 *     tags: [ShoppingListItem]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: The shopping list item ID
 *     responses:
*       200:
*         description: Shopping list item status updated successfully
 */
// PATCH /api/list-items/:id/toggle - Toggle the checked status of a shopping list item
router.patch('/list-items/:id/toggle', requireUser, requireListItemMember('id'), toggleListItemChecked);

/**
 * @swagger
 * /api/list-items/{id}:
 *   delete:
 *     summary: Remove an item from a shopping list
 *     tags: [ShoppingListItem]
 *     parameters:
*       - in: path
*         name: id
*         schema:
*           type: integer
*         required: true
*         description: The shopping list item ID
*     responses:
*       200:
*         description: Shopping list item removed successfully
 */
// DELETE /api/list-items/:id - Remove an item from a shopping list
router.delete('/list-items/:id', requireUser, requireListItemMember('id'), removeListItem);

export default router;