import { Router } from 'express';
import { addPrice, fetchLatestPriceByStoreProduct, fetchLatestPricesAcrossStores, fetchActivePromoPrices, fetchPriceHistoryForStoreProduct } from '../controllers/priceController';

const router = Router();

/**
 * @swagger
 * /api/prices:
 *   post:
 *     summary: Create a new price entry
 *     tags: [Price]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - storeProductId
 *               - price
 *             properties:
 *               storeProductId:
 *                 type: integer
 *                 example: 1
 *               price:
 *                 type: number
 *                 format: float
 *                 example: 10.99
 *     responses:
 *       201:
 *         description: Price created successfully
 *       400:
 *         description: Store product ID or price is required
 */
// POST /api/prices - Create a new price entry
router.post('/prices', addPrice);

/**
 * @swagger
 * /api/prices/store-product/{storeProductId}:
 *   get:
 *     summary: Get the latest price for a specific store product
 *     tags: [Price]
 *     parameters:
 *       - in: path
 *         name: storeProductId
 *         schema:
 *           type: integer
 *         required: true
 *         description: The store product ID
 *     responses:
 *       200:
*         description: The latest price for the store product
 */
// GET /api/prices/store-product/:storeProductId - Get the latest price for a specific store product
router.get('/prices/store-product/:storeProductId', fetchLatestPriceByStoreProduct);

/**
 * @swagger
 * /api/prices/product/{productId}:
 *   get:
 *     summary: Get the latest prices across all stores for a specific product
 *     tags: [Price]
 *     parameters:
 *       - in: path
 *         name: productId
 *         schema:
 *           type: integer
 *         required: true
 *         description: The product ID
 *     responses:
 *       200:
 *         description: A list of the latest prices for the product
 */
// GET /api/prices/product/:productId - Get the latest prices across all stores for a specific product
router.get('/prices/product/:productId', fetchLatestPricesAcrossStores);

/**
 * @swagger
 * /api/prices/promos:
 *   get:
 *     summary: Get all active promotional prices
 *     tags: [Price]
 *     responses:
 *       200:
 *         description: A list of active promotional prices
 */
// GET /api/prices/promos - Get all active promotional prices
router.get('/prices/promos', fetchActivePromoPrices);

/**
 * @swagger
 * /api/prices/history/store-product/{storeProductId}:
 *   get:
 *     summary: Get the price history for a specific store product
 *     tags: [Price]
 *     parameters:
 *       - in: path
 *         name: storeProductId
 *         schema:
 *           type: integer
 *         required: true
 *         description: The store product ID
 *     responses:
 *       200:
 *         description: The price history for the store product
 */
// GET /api/prices/history/store-product/:storeProductId - Get the price history for a specific store product
router.get('/prices/history/store-product/:storeProductId', fetchPriceHistoryForStoreProduct);

export default router;