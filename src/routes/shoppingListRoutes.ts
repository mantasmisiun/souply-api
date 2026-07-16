import { Router } from 'express';
import {
    addShoppingList,
    fetchShoppingListsByUserId,
    fetchShoppingListById,
    removeShoppingList,
    changeShoppingListStatus,
    duplicateList,
    createListShareToken,
    getShareTokenStatus,
    claimShareToken,
    linkReceiptToShoppingList,
    skipListReceipt,
    unskipListReceipt,
} from '../controllers/shoppingListController.js';
import { requireUser, requireSelfUserParam } from '../middleware/sessionAuth.js';
import { requireListMember, requireListOwner } from '../middleware/resourceAuth.js';

const router = Router();

// Shopping lists are COLLABORATIVE (ShoppingListMember + share tokens): most routes accept
// any MEMBER (requireListMember), only the destructive whole-list DELETE requires the strict
// CREATOR (requireListOwner). The share-token status/claim routes are authorized by POSSESSION
// OF THE UNGUESSABLE TOKEN (the claimer is a stranger to the list) — they take requireUser to
// attribute the claim but MUST NOT get a member/owner check or claiming a shared list breaks.
const member = requireListMember('id');

/**
 * @swagger
 * /api/shopping-lists:
 *   post:
 *     summary: Create a new shopping list
 *     tags: [ShoppingList]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - storeId
 *             properties:
 *               userId:
 *                 type: string
 *                 format: uuid
 *                 example: 954b8b32-3976-4cb3-a3dd-5b035ec87d24
 *               storeId:
 *                 type: integer
 *                 example: 1
 *     responses:
 *       201:
 *         description: Shopping list created successfully
 */
// POST /api/shopping-lists - Create a new shopping list
router.post('/shopping-lists', requireUser, addShoppingList);

/**
 * @swagger
 * /api/shopping-lists/user/{userId}:
 *   get:
 *     summary: Get all shopping lists for a user
 *     tags: [ShoppingList]
 *     parameters:
 *       - in: path
 *         name: userId
 *         schema:
 *           type: string
 *           format: uuid
 *         required: true
 *         description: The user ID
 *     responses:
 *       200:
 *         description: A list of shopping lists for the user
 */
// GET /api/shopping-lists/user/:userId - Get all shopping lists for a user
router.get('/shopping-lists/user/:userId', requireUser, requireSelfUserParam, fetchShoppingListsByUserId);

/**
 * @swagger
 * /api/shopping-lists/{id}:
 *   get:
 *     summary: Get a single shopping list by ID
 *     tags: [ShoppingList]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: The shopping list ID
 *     responses:
 *       200:
 *         description: A single shopping list
 */
// GET /api/shopping-lists/:id - Get a single shopping list by ID
router.get('/shopping-lists/:id', requireUser, member, fetchShoppingListById);

/**
 * @swagger
 * /api/shopping-lists/{id}:
 *   delete:
 *     summary: Delete a shopping list by ID
 *     tags: [ShoppingList]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: The shopping list ID
 *     responses:
 *       200:
 *         description: Shopping list deleted successfully
 */
// DELETE /api/shopping-lists/:id - Delete a shopping list by ID
router.delete('/shopping-lists/:id', requireUser, requireListOwner('id'), removeShoppingList);

router.patch('/shopping-lists/:id/status', requireUser, member, changeShoppingListStatus);

router.post('/shopping-lists/:id/duplicate', requireUser, member, duplicateList);

// Link an uploaded/scanned receipt to a completed list row (post-completion
// receipt upload flow + duplicate silent-link).
router.post('/shopping-lists/:id/link-receipt', requireUser, member, linkReceiptToShoppingList);
// 2.0 mini-cycles: close/reopen a slot without a receipt ("Nepirkau čia").
router.post('/shopping-lists/:id/skip-receipt', requireUser, member, skipListReceipt);
router.post('/shopping-lists/:id/unskip-receipt', requireUser, member, unskipListReceipt);

// Sharing: creator mints a token, scanner claims it. The /status route
// is polled by the creator-side QR modal (~1.5s cadence) to detect a
// scan without needing a persistent socket.
router.post('/shopping-lists/:id/share', requireUser, member, createListShareToken);
router.get('/shopping-lists/share/:token/status', requireUser, getShareTokenStatus);
router.post('/shopping-lists/share/:token/claim', requireUser, claimShareToken);

export default router;