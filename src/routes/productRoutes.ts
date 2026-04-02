import { Router } from 'express';
import { addProduct, searchProducts, fetchProductById, fetchProductsByCategory  } from '../controllers/productController';

const router = Router();

// POST /api/products - Create a new product
router.post('/products', addProduct);

// GET /api/products/search?q= - Search products by name
router.get('/products/search', searchProducts);

// GET /api/products/:id - Get a single product by ID
router.get('/products/:id', fetchProductById);

// GET /api/categories/:categoryId/products - Get products by category ID
router.get('/categories/:categoryId/products', fetchProductsByCategory);

export default router;