import { Router } from 'express';
import { addStoreChain, addStore, fetchAllStores, fetchStoreById } from '../controllers/storeController';

const router = Router();

// POST /api/chains - Create a new store chain
router.post('/chains', addStoreChain);

// POST /api/stores - Create a new store
router.post('/stores', addStore);

// GET /api/stores - Get all stores
router.get('/stores', fetchAllStores);

// GET /api/stores/:id - Get a single store by ID
router.get('/stores/:id', fetchStoreById);

export default router;