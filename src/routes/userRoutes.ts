import { Router } from 'express';
import { addUser, fetchUserById, updateUserLastActive, fetchUserProfile, fetchUserEquivalences, putUserEquivalence, deleteUserEquivalence, fetchUserProductMergeMap, fetchUserStats, fetchUserVoteHistory, editUserVotePair, deleteSelfAccount } from '../controllers/userController.js';
import { recoverAccount } from '../controllers/accountRecoveryController.js';

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
 * /api/users/recover:
 *   post:
 *     summary: Recover an account using 3 previously-uploaded receipts
 *     description: |
 *       Spec: Documentation/roadmap/user-accounts-recovery.md
 *       Match key per receipt: receiptNo + date + total (within 0.01€).
 *       All 3 must point to the same userId across at least 2 different
 *       store chains. Rate-limited to 3 failures per 24h per device.
 *       Any fresh-install activity is auto-merged into the recovered account.
 *     tags: [User]
 *     responses:
 *       200: { description: 'JSON { status: success | failed | locked, ... }' }
 *       400: { description: Bad request body }
 */
router.post('/users/recover', recoverAccount);

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
 * /api/users/{id}:
 *   delete:
 *     summary: User-initiated self-delete (anonymize mode)
 *     description: |
 *       Deletes the User row, receipts, basket, and shopping list. Anonymises
 *       vote rows (StoreProductMatchVote.userId → NULL) so the user's
 *       contributions to the shared price catalog remain. PII is stripped
 *       from receipt parsedData before deletion. Admin-only `purge` mode is
 *       a separate endpoint under /admin/users/:id.
 *     tags: [User]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema: { type: string, format: uuid }
 *         required: true
 *     responses:
 *       204: { description: Account deleted }
 *       404: { description: User not found }
 */
router.delete('/users/:id', deleteSelfAccount);

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