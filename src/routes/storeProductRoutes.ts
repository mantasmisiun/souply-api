import { Router } from 'express';
import { addStoreProduct, fetchStoreProductsByProductId, fetchStoreProductsByChainId, fetchStoreProductByName, fetchStoreProductByProductAndChain, searchStoreProductsByChain } from '../controllers/storeProductController';

const router = Router();
/**
 * @swagger
 * /api/store-products:
 *   post:
 *     summary: Create a new store product
 *     tags: [StoreProduct]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - productId
 *               - chainId
 *               - storeProductName
 *             properties:
 *               productId:
 *                 type: integer
 *                 example: 1
 *               chainId:
 *                 type: integer
 *                 example: 1
 *               storeProductName:
 *                 type: string
 *                 example: Kava
 *               brandName:
 *                 type: string
 *                 example: Nescafe
 *     responses:
 *       201:
 *         description: Store product created successfully
 *       400:
 *         description: Product ID, chain ID, or store product name is required
 */
// POST /api/store-products - Create a new store product
router.post('/store-products', addStoreProduct);

/**
 * @swagger
 * /api/store-products/product/{productId}:
 *   get:
 *     summary: Get store products by product ID
 *     tags: [StoreProduct]
 *     parameters:
 *       - in: path
 *         name: productId
 *         schema:
 *           type: integer
 *         required: true
 *         description: The product ID
 *     responses:
 *       200:
 *         description: A list of store products
 */
// GET /api/store-products/product/:productId - Get store products by product ID
router.get('/store-products/product/:productId', fetchStoreProductsByProductId);

/**
 * @swagger
 * /api/store-products/chain/{chainId}:
 *   get:
 *     summary: Get store products by chain ID
 *     tags: [StoreProduct]
 *     parameters:
 *       - in: path
 *         name: chainId
 *         schema:
 *           type: integer
 *         required: true
 *         description: The chain ID
 *     responses:
 *       200:
 *         description: A list of store products
 */
// GET /api/store-products/chain/:chainId - Get store products by chain ID
router.get('/store-products/chain/:chainId', fetchStoreProductsByChainId);

/**
 * @swagger
 * /api/store-products/search:
 *   get:
 *     summary: Search store products by name
 *     tags: [StoreProduct]
 *     parameters:
 *       - in: query
 *         name: name
 *         schema:
 *           type: string
 *         required: true
 *         description: The search query
 *     responses:
*       200:
*         description: A list of store products
 */
// GET /api/store-products/search?name= - Get store products by name
router.get('/store-products/search', searchStoreProductsByChain);

router.get('/store-products/by-product-chain', fetchStoreProductByProductAndChain);

export default router;