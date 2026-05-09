import { Router } from 'express';
import { addUser, fetchUserById, updateUserLastActive, fetchUserProfile, fetchUserEquivalences, putUserEquivalence, deleteUserEquivalence, fetchUserProductMergeMap, fetchUserStats, fetchUserVoteHistory, editUserVotePair } from '../controllers/userController.js';

const router = Router();

/**
 * @swagger
 * /api/users:
 *   post:
 *     summary: Create a new anonymous user
 *     tags: [User]
 *     responses:
 *       201:
 *         description: User created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                   format: uuid
 *                   example: 954b8b32-3976-4cb3-a3dd-5b035ec87d24
 */
router.post('/users', addUser);

/**
 * @swagger
 * /api/users/{id}:
 *   get:
 *     summary: Get a user by ID
 *     tags: [User]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *           format: uuid
 *         required: true
 *         description: The user ID
 *     responses:
 *       200:
 *         description: User retrieved successfully
 */
router.get('/users/:id', fetchUserById);

/**
 * @swagger
 * /api/users/{id}/last-active:
 *   patch:
 *     summary: Update user's last active time
 *     tags: [User]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *           format: uuid
 *         required: true
 *         description: The user ID
 *     responses:
 *       200:
 *         description: User's last active time updated successfully
 */
router.patch('/users/:id/last-active', updateUserLastActive);
router.get('/users/:id/profile', fetchUserProfile);
router.get('/users/:id/equivalences', fetchUserEquivalences);
router.put('/users/:id/equivalences', putUserEquivalence);
router.delete('/users/:id/equivalences', deleteUserEquivalence);
router.get('/users/:id/product-merge-map', fetchUserProductMergeMap);
router.get('/users/:id/stats', fetchUserStats);
router.get('/users/:id/votes', fetchUserVoteHistory);
router.put('/users/:id/votes/pair', editUserVotePair);

export default router;