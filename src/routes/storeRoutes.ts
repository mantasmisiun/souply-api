import { Router } from 'express';
import { addStoreChain, addStore, fetchAllStores, fetchStoreById, fetchAllChains } from '../controllers/storeController';

const router = Router();

/**
 * @swagger
 * /api/chains:
 *   post:
 *     summary: Create a new store chain
 *     tags: [StoreChain]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 example: Maxima
 *               logoUrl:
 *                 type: string
 *                 nullable: true
 *                 example: null
 *     responses:
 *       201:
 *         description: Store chain created successfully
 *       400:
 *         description: Name is required
 */
router.post('/chains', addStoreChain);

/**
 * @swagger
 * /api/stores:
 *   post:
 *     summary: Create a new store
 *     tags: [Store]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - chainId
 *               - name
 *               - address
 *               - latitude
 *               - longitude
 *             properties:
 *               chainId:
 *                 type: integer
 *                 example: 1
 *               name:
 *                 type: string
 *                 example: X-912 MAXIMA
 *               address:
 *                 type: string
 *                 example: Aido g. 8-1, Šiauliai
 *               latitude:
 *                 type: number
 *                 example: 55.90859
 *               longitude:
 *                 type: number
 *                 example: 23.26102
 *     responses:
 *       201:
 *         description: Store created successfully
 *       400:
 *         description: All fields are required
 */
router.post('/stores', addStore);

/**
 * @swagger
 * /api/stores:
 *   get:
 *     summary: Get all stores
 *     tags: [Store]
 *     responses:
 *       200:
 *         description: List of all stores
 */
router.get('/stores', fetchAllStores);

/**
 * @swagger
 * /api/stores/{id}:
 *   get:
 *     summary: Get a store by ID
 *     tags: [Store]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         example: 1
 *     responses:
 *       200:
 *         description: Store found
 *       404:
 *         description: Store not found
 */
router.get('/stores/:id', fetchStoreById);

router.get('/chains', fetchAllChains);

export default router;