import { Router } from 'express';
import { addBasketItem, fetchBasketItemsByBasketId, updateBasketItem, removeBasketItem } from '../controllers/basketItemController.js';

const router = Router();

/**
 * @swagger
 * /api/basket-items:
 *   post:
 *     summary: Add an item to a basket
 *     tags: [BasketItem]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - basketId
 *               - productId
 *               - quantity
 *             properties:
 *               basketId:
 *                 type: integer
 *                 example: 1
 *               productId:
 *                 type: integer
 *                 example: 1
 *               quantity:
 *                 type: integer
 *                 minimum: 1
 *     responses:
 *       201:
 *         description: Basket item added successfully
 */
// POST /api/basket-items - Add an item to a basket
router.post('/basket-items', addBasketItem);

/**
 * @swagger
 * /api/baskets/{basketId}/items:
 *   get:
 *     summary: Get all items in a basket
 *     tags: [BasketItem]
 *     parameters:
 *       - in: path
 *         name: basketId
 *         schema:
 *           type: integer
 *         required: true
 *         description: The basket ID
 *     responses:
 *       200:
 *         description: A list of items in the basket
 */
// GET /api/baskets/:basketId/items - Get all items in a basket
router.get('/baskets/:basketId/items', fetchBasketItemsByBasketId);

/**
 * @swagger
 * /api/basket-items/{id}:
 *   put:
 *     summary: Update the quantity of a basket item
 *     tags: [BasketItem]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: The basket item ID
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
 *         description: Basket item updated successfully
 */
// PUT /api/basket-items/:id - Update the quantity of a basket item
router.put('/basket-items/:id', updateBasketItem);

/**
 * @swagger
 * /api/basket-items/{id}:
 *   delete:
 *     summary: Remove an item from a basket
 *     tags: [BasketItem]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: The basket item ID
 *     responses:
 *       200:
 *         description: Basket item removed successfully
 */
// DELETE /api/basket-items/:id - Remove an item from a basket
router.delete('/basket-items/:id', removeBasketItem);

export default router;