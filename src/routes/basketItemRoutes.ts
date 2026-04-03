import { Router } from 'express';
import { addBasketItem, fetchBasketItemsByBasketId, updateBasketItem, removeBasketItem } from '../controllers/basketItemController';

const router = Router();

// POST /api/basket-items - Add an item to a basket
router.post('/basket-items', addBasketItem);

// GET /api/baskets/:basketId/items - Get all items in a basket
router.get('/baskets/:basketId/items', fetchBasketItemsByBasketId);

// PUT /api/basket-items/:id - Update the quantity of a basket item
router.put('/basket-items/:id', updateBasketItem);

// DELETE /api/basket-items/:id - Remove an item from a basket
router.delete('/basket-items/:id', removeBasketItem);

export default router;