import { Router } from 'express';
import { claimInvite, verifyEmail, openDeepLink } from '../controllers/adminInviteController.js';

const router = Router();

// Public — no auth required (the token IS the auth)
router.post('/admin-invite/claim',  claimInvite);
router.get('/admin-invite/verify',  verifyEmail);
router.get('/admin-invite/open',    openDeepLink);

export default router;
