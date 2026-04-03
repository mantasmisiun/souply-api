import { Router } from 'express';
import { addStoreProduct, fetchStoreProductsByProductId, fetchStoreProductsByChainId, fetchStoreProductByName } from '../controllers/storeProductController';

const router = Router();

// POST /api/store-products - Create a new store product
router.post('/store-products', addStoreProduct);

// GET /api/store-products/product/:productId - Get store products by product ID
router.get('/store-products/product/:productId', fetchStoreProductsByProductId);

// GET /api/store-products/chain/:chainId - Get store products by chain ID
router.get('/store-products/chain/:chainId', fetchStoreProductsByChainId);

// GET /api/store-products/search?name= - Get store products by name
router.get('/store-products/search', fetchStoreProductByName);

export default router;