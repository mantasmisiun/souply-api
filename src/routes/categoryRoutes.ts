import { Router } from 'express';
import { addCategory, fetchAllCategories, fetchSubCategories } from '../controllers/categoryController';

const router = Router();

// POST /api/categories - Create a new category
router.post('/categories', addCategory);

// GET /api/categories - Get all top-level categories
router.get('/categories', fetchAllCategories);

// GET /api/categories/:id/subcategories - Get subcategories of a category
router.get('/categories/:id/subcategories', fetchSubCategories);

export default router;