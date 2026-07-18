import { Router } from 'express';
import { previewSmartBasket } from '../controllers/smartBasketController.js';
import { requireUser } from '../middleware/sessionAuth.js';
import { attachVerifiedUser } from '../middleware/requireVerifiedUser.js';

const router = Router();

// Smart Basket generator (shared/SMART_BASKET_SPEC.md). Preview only — the
// client creates the actual draft basket through the existing basket routes.
router.post('/smart-basket/preview', requireUser, attachVerifiedUser, previewSmartBasket);

export default router;
