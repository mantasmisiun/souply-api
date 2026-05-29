import { Router } from 'express';
import { createBetaSignup } from '../controllers/betaSignupController.js';

const router = Router();

/**
 * @swagger
 * /api/beta-signups:
 *   post:
 *     summary: Capture a landing-page beta signup
 *     tags: [Beta]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email]
 *             properties:
 *               name:     { type: string }
 *               email:    { type: string }
 *               platform: { type: string, enum: [ios, android] }
 *     responses:
 *       201: { description: Signup captured }
 *       400: { description: Invalid name or email }
 */
router.post('/beta-signups', createBetaSignup);

export default router;
