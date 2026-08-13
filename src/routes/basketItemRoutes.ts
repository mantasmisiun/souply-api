import { Router } from 'express';
import { addBasketItem, fetchBasketItemsByBasketId, fetchBasketQuantities, putBasketItemByProduct, updateBasketItem, removeBasketItem, convertBasketMode } from '../controllers/basketItemController.js';
import { requireUser } from '../middleware/sessionAuth.js';
import { requireBasketOwner, requireBasketOwnerFromBody, requireBasketItemWritable, requireBasketWritable } from '../middleware/resourceAuth.js';

const router = Router();

// Basket items belong to a basket → its owner. Item CRUD binds to the parent basket's
// owner (POST reads basketId from the body; :id item routes resolve item→basket→userId).

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
router.post('/basket-items', requireUser, requireBasketOwnerFromBody('basketId'), addBasketItem);

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
router.get('/baskets/:basketId/items', requireUser, requireBasketWritable('basketId'), fetchBasketItemsByBasketId);

/**
 * @swagger
 * /api/baskets/{basketId}/quantities:
 *   get:
 *     summary: productId → quantity map for a basket (catalog Add/stepper state)
 *     tags: [BasketItem]
 *     responses:
 *       200:
 *         description: '{ "12": 2, "48": 0.5 }'
 */
// The catalog surfaces' cheap read — see fetchBasketQuantities. /items stays for
// the basket screen, which needs names, images and canonical units.
router.get('/baskets/:basketId/quantities', requireUser, requireBasketWritable('basketId'), fetchBasketQuantities);

/**
 * @swagger
 * /api/baskets/{basketId}/items/by-product/{productId}:
 *   put:
 *     summary: Set a product's quantity in a basket (upsert; 0 removes)
 *     tags: [BasketItem]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [quantity]
 *             properties:
 *               quantity: { type: number, example: 2 }
 *               matchMode: { type: string, enum: [sku, base] }
 *     responses:
 *       200:
 *         description: '{ id, quantity, created, remaining, revertedToDraft }'
 */
// The stepper's write: ONE round trip, addressed by product. Owner-gated on the
// parent basket exactly like the other item routes.
router.put('/baskets/:basketId/items/by-product/:productId', requireUser, requireBasketWritable('basketId'), putBasketItemByProduct);

// POST /api/baskets/:basketId/convert-mode - flip all items in a basket
// between 'sku' and 'base'. Sums quantities on sku→base cluster collisions.
router.post('/baskets/:basketId/convert-mode', requireUser, requireBasketWritable('basketId'), convertBasketMode);

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
router.put('/basket-items/:id', requireUser, requireBasketItemWritable('id'), updateBasketItem);

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
router.delete('/basket-items/:id', requireUser, requireBasketItemWritable('id'), removeBasketItem);

export default router;