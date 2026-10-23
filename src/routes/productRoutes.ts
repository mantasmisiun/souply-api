import { Router } from 'express';
import { addProduct, searchProducts, fetchProductById, fetchProductsByCategory, fetchProductsByCategoryWithAmounts, fetchAllProductsByL2WithAmounts, fetchDiscountedProducts, fetchProductPackSizes } from '../controllers/productController.js';

const router = Router();
/**
 * @swagger
 * /api/products:
 *   post:
 *     summary: Create a new product
 *     tags: [Product]
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
 *                 example: Kava
 *               imageUrl:
 *                 type: string
 *                 nullable: true
 *                 example: null
 *               categoryId:
 *                 type: integer
 *                 example: 1
 *               baseProductId:
 *                 type: integer
 *                 nullable: true
 *                 example: null
 *     responses:
 *       201:
 *         description: Product created successfully
 *       400:
 *         description: Name is required
 */
// POST /api/products - Create a new product
router.post('/products', addProduct);

/**
 * @swagger
 * /api/products/search:
 *   get:
 *     summary: Search products by name
 *     tags: [Product]
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         required: true
 *         description: The search query
 *     responses:
 *       200:
 *         description: A list of products
 */
// GET /api/products/search?q= - Search products by name
router.get('/products/search', searchProducts);

// GET /api/products/discounted?l2CategoryId=&search= - Products with active promos
router.get('/products/discounted', fetchDiscountedProducts);

/**
 * @swagger
 * /api/products/{id}:
 *   get:
 *     summary: Get a single product by ID
 *     tags: [Product]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: The product ID
 *     responses:
 *       200:
 *         description: A single product
 */
// GET /api/products/:id - Get a single product by ID
router.get('/products/:id/pack-sizes', fetchProductPackSizes);
router.get('/products/:id', fetchProductById);

/**
 * @swagger
 * /api/categories/{categoryId}/products:
 *   get:
 *     summary: Get products by category ID
 *     tags: [Product]
 *     parameters:
 *       - in: path
 *         name: categoryId
 *         schema:
 *           type: integer
 *         required: true
 *         description: The category ID
 *     responses:
 *       200:
 *         description: A list of products
 */
// GET /api/categories/:categoryId/products - Get products by category ID
router.get('/categories/:categoryId/products', fetchProductsByCategory);

router.get('/categories/:categoryId/products-with-amounts', fetchProductsByCategoryWithAmounts);

router.get('/categories/:categoryId/all-products-with-amounts', fetchAllProductsByL2WithAmounts);

export default router;