import { Router } from 'express';
import { addPrice, fetchLatestPriceByStoreProduct, fetchLatestPricesAcrossStores, fetchActivePromoPrices, fetchPriceHistoryForStoreProduct } from '../controllers/priceController';

const router = Router();

// POST /api/prices - Create a new price entry
router.post('/prices', addPrice);

// GET /api/prices/store-product/:storeProductId - Get the latest price for a specific store product
router.get('/prices/store-product/:storeProductId', fetchLatestPriceByStoreProduct);

// GET /api/prices/product/:productId - Get the latest prices across all stores for a specific product
router.get('/prices/product/:productId', fetchLatestPricesAcrossStores);

// GET /api/prices/promos - Get all active promotional prices
router.get('/prices/promos', fetchActivePromoPrices);

// GET /api/prices/history/store-product/:storeProductId - Get the price history for a specific store product
router.get('/prices/history/store-product/:storeProductId', fetchPriceHistoryForStoreProduct);

export default router;