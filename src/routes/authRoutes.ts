import { Router } from 'express';
import {
    oauthSignIn,
    fetchMe,
    setUsername,
    checkUsernameAvailable,
    patchProfile,
    setAvatar,
    fetchPublicProfile,
} from '../controllers/authController.js';
import { requireVerifiedUser } from '../middleware/requireVerifiedUser.js';

const router = Router();

/**
 * @swagger
 * /api/auth/oauth:
 *   post:
 *     summary: Sign in with Google or Apple, link anonymous UUID → verified user
 *     tags: [Auth]
 */
router.post('/auth/oauth', oauthSignIn);

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     summary: Return the authed verified user's profile fields
 *     tags: [Auth]
 */
router.get('/auth/me', requireVerifiedUser, fetchMe);

/**
 * @swagger
 * /api/users/me/username:
 *   patch:
 *     summary: Set or change the authed user's handle (3–20 chars, unique, 30-day cooldown)
 *     tags: [Auth]
 */
router.patch('/users/me/username', requireVerifiedUser, setUsername);

/**
 * @swagger
 * /api/users/username-available:
 *   get:
 *     summary: Availability check for a candidate handle (verified-only)
 *     tags: [Auth]
 */
router.get('/users/username-available', requireVerifiedUser, checkUsernameAvailable);

/**
 * @swagger
 * /api/users/me/profile:
 *   patch:
 *     summary: Update displayName and/or bio
 *     tags: [Auth]
 */
router.patch('/users/me/profile', requireVerifiedUser, patchProfile);

/**
 * @swagger
 * /api/users/me/avatar:
 *   post:
 *     summary: Upload an avatar (base64 JSON body, ≤ 2 MB)
 *     tags: [Auth]
 */
router.post('/users/me/avatar', requireVerifiedUser, setAvatar);

/**
 * @swagger
 * /api/users/@{username}:
 *   get:
 *     summary: Public profile for the souply.lt/@username page
 *     tags: [Auth]
 */
router.get('/users/@:username', fetchPublicProfile);

export default router;
