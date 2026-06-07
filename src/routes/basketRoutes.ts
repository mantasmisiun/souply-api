import { Router } from 'express';
import { addBasket, fetchBasketsByUserId, fetchBasketById, updateBasket, changeBasketStatus, removeBasket, renameBasket, calculateBasket, getBasketStorePrices, copyBasket } from '../controllers/basketController.js';
import { storePricesLimiter } from '../middleware/rateLimit.js';

const router = Router();
/**
 * @swagger
 * /api/baskets:
 *   post:
 *     summary: Create a new basket
 *     tags: [Basket]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *             properties:
 *               userId:
 *                 type: string
 *                 format: uuid
 *                 example: 954b8b32-3976-4cb3-a3dd-5b035ec87d24
 *     responses:
 *       201:
 *         description: Basket created successfully
 *       400:
 *         description: User ID is required
 */
// POST /api/baskets - Create a new basket
router.post('/baskets', addBasket);
/**
 * @swagger
 * /api/baskets/user/{userId}:
 *   get:
 *     summary: Get all baskets for a specific user
 *     tags: [Basket]
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
 *         description: A list of baskets for the user 
 */
// GET /api/baskets/user/:userId - Get all baskets for a specific user
router.get('/baskets/user/:userId', fetchBasketsByUserId);
/**
 * @swagger
 * /api/baskets/{id}:
 *   get:
 *     summary: Get a single basket by ID
 *     tags: [Basket]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: The basket ID
 *     responses:
 *       200:
 *         description: Basket retrieved successfully
 */
// GET /api/baskets/:id - Get a single basket by ID
router.get('/baskets/:id', fetchBasketById);

/**
 * @swagger
 * /api/baskets/{id}:
 *   patch:
 *     summary: Update a basket's updated_at timestamp
 *     tags: [Basket]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: The basket ID
 *     responses:
 *       200:
 *         description: Basket updated successfully
 */
// PATCH /api/baskets/:id - Update a basket's updated_at timestamp
router.patch('/baskets/:id', updateBasket);

/**
 * @swagger
 * /api/baskets/{id}/status:
 *   patch:
 *     summary: Change the status of a basket
 *     tags: [Basket]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: The basket ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [draft, compared, completed]
 *                 example: compared
 *     responses:
 *       200:
 *         description: Basket status updated successfully
 */
// PATCH /api/baskets/:id/status - Change the status of a basket
router.patch('/baskets/:id/status', changeBasketStatus);

/**
 * @swagger
 * /api/baskets/{id}:
 *   delete:
 *     summary: Delete a basket by ID
 *     tags: [Basket]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: The basket ID
 *     responses:
 *       200:
 *         description: Basket deleted successfully
 */
// DELETE /api/baskets/:id - Delete a basket by ID
router.delete('/baskets/:id', removeBasket);

router.patch('/baskets/:id/name', renameBasket);

router.post('/baskets/:id/calculate', calculateBasket);

// On-demand map pricing — body { storeIds:number[1..10], lat?, lng? }.
// Read-only, cached, rate-limited. Powers tap-a-pin + "calculate this area".
router.post('/baskets/:id/store-prices', storePricesLimiter, getBasketStorePrices);

router.post('/baskets/:id/copy', copyBasket);

export default router;