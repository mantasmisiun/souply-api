import { Router } from 'express';
import { addStoreProduct, fetchStoreProductsByProductId, fetchStoreProductsByChainId, fetchStoreProductByProductAndChain, searchStoreProductsByChain, matchStoreProductByName, searchUnifiedStoreProductsByChain, getStoreProductUploadUrl } from '../controllers/storeProductController.js';

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
 *                 example: Smulkiavaisiai slyviniai pomidorai, 250 g
 *               brandName:
 *                 type: string
 *                 nullable: true
 *                 example: null
 *               isWeighable:
 *                 type: boolean
 *                 example: false
 *               amount:
 *                 type: number
 *                 nullable: true
 *                 example: 250
 *               unit:
 *                 type: string
 *                 nullable: true
 *                 example: g
 *     responses:
 *       201:
 *         description: Store product created successfully
 *       400:
 *         description: productId, chainId, and storeProductName are required
 */
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


/**
 * @swagger
 * /api/store-products/match:
 *   get:
 *     summary: Find top product matches by fuzzy name for a chain
 *     tags: [StoreProduct]
 *     parameters:
 *       - in: query
 *         name: chainId
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: name
 *         required: true
 *         schema: { type: string }
 *         example: "Bananai Cavendish 20+cm"
 *       - in: query
 *         name: amount
 *         required: false
 *         schema: { type: number }
 *       - in: query
 *         name: unit
 *         required: false
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Up to 3 match candidates with confidence, sorted highest first
 */
router.get('/store-products/match', matchStoreProductByName);
router.get('/store-products/search-unified', searchUnifiedStoreProductsByChain);
router.post('/store-products/upload-url', getStoreProductUploadUrl);

export default router;