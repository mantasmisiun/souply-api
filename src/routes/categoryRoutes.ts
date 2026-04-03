import { Router } from 'express';
import { addCategory, fetchAllCategories, fetchSubCategories } from '../controllers/categoryController';

const router = Router();
/**
 * @swagger
 * /api/categories:
 *   post:
 *     summary: Create a new category
 *     tags: [Category]
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
 *                 example: Maisto produktai
 *               parentCategoryId:
 *                 type: integer
 *                 nullable: true
 *                 example: null
 *     responses:
 *       201:
 *         description: Category created successfully
 *       400:
 *         description: Name is required
 */

// POST /api/categories - Create a new category
router.post('/categories', addCategory);

/**
 * @swagger
 * /api/categories:
 *   get:
 *     summary: Get all top-level categories
 *     tags: [Category]
 *     responses:
 *       200:
 *         description: A list of categories
 */
// GET /api/categories - Get all top-level categories
router.get('/categories', fetchAllCategories);

/**
 * @swagger
 * /api/categories/{id}/subcategories:
 *   get:
 *     summary: Get subcategories of a category
 *     tags: [Category]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: The category ID
 *     responses:
 *       200:
 *         description: A list of subcategories
 */
// GET /api/categories/:id/subcategories - Get subcategories of a category
router.get('/categories/:id/subcategories', fetchSubCategories);

export default router;