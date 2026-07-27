import { Router } from 'express';
import { importRecipe } from '../controllers/recipeImportController.js';
import { recipeImportLimiter } from '../middleware/rateLimit.js';
import { requireUser } from '../middleware/sessionAuth.js';

const router = Router();

// Recipe import from a URL the user pasted. Rate-limited even behind auth: the
// handler makes an OUTBOUND request to a host the caller chooses, so the limit
// is what stops our server being used as someone else's fetch proxy.
router.post('/recipes/import', requireUser, recipeImportLimiter, importRecipe);

export default router;
