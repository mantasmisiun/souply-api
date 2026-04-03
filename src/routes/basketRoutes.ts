import { Router } from 'express';
import { addBasket, fetchBasketsByUserId, fetchBasketById, updateBasket, changeBasketStatus, removeBasket } from '../controllers/basketController';

const router = Router();

// POST /api/baskets - Create a new basket
router.post('/baskets', addBasket);

// GET /api/baskets/user/:userId - Get all baskets for a specific user
router.get('/baskets/user/:userId', fetchBasketsByUserId);

// GET /api/baskets/:id - Get a single basket by ID
router.get('/baskets/:id', fetchBasketById);

// PATCH /api/baskets/:id - Update a basket's updated_at timestamp
router.patch('/baskets/:id', updateBasket);

// PATCH /api/baskets/:id/status - Change the status of a basket
router.patch('/baskets/:id/status', changeBasketStatus);

// DELETE /api/baskets/:id - Delete a basket by ID
router.delete('/baskets/:id', removeBasket);

export default router;