import { Router } from 'express';
import { addReceipt, fetchReceiptById, fetchReceiptsByUserId, updateReceiptOcrDetails, removeReceipt, fetchReceiptImage, processReceiptManually, fetchReceiptItems, updateReceiptItem, addReceiptItem } from '../controllers/receiptController';

const router = Router();

/**
 * @swagger
 * /api/receipts:
 *   post:
 *     summary: Add a new receipt
 *     tags: [Receipt]
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
 *         description: Receipt added successfully
 */
// POST /api/receipts - Add a new receipt
router.post('/receipts', addReceipt);

/**
 * @swagger
 * /api/users/{userId}/receipts:
 *   get:
 *     summary: Get all receipts for a user
 *     tags: [Receipt]
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
 *         description: A list of receipts for the user
 */
// GET /api/users/:userId/receipts - Get all receipts for a user
router.get('/users/:userId/receipts', fetchReceiptsByUserId);

/**
 * @swagger
 * /api/receipts/{id}:
 *   get:
 *     summary: Get a receipt by ID
 *     tags: [Receipt]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: The receipt ID
 *     responses:
 *       200:
 *         description: A single receipt
 */
// GET /api/receipts/:id - Get a receipt by ID
router.get('/receipts/:id', fetchReceiptById);

/**
 * @swagger
 * /api/receipts/{id}/details:
 *   patch:
 *     summary: Update receipt OCR details
 *     tags: [Receipt]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: The receipt ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - receiptNo
 *               - receiptDate
 *               - processingStatus
 *             properties:
 *               receiptNo:
 *                 type: string
 *                 example: "132610"
 *               receiptDate:
 *                 type: string
 *                 format: date-time
 *                 example: "2026-03-29 16:42:09"
 *               processingStatus:
 *                 type: string
 *                 enum: [pending, processing, completed, failed]
 *                 example: completed
 *     responses:
 *       200:
 *         description: Receipt OCR details updated successfully
 */
// PATCH /api/receipts/:id/details - Update receipt OCR details
router.patch('/receipts/:id/details', updateReceiptOcrDetails);

/**
 * @swagger
 * /api/receipts/{id}:
 *   delete:
 *     summary: Delete a receipt
 *     tags: [Receipt]
 *     parameters:
*       - in: path
*         name: id
*         schema:
*           type: integer
*         required: true
*         description: The receipt ID
*     responses:
*       200:
*         description: Receipt deleted successfully
 */
// DELETE /api/receipts/:id - Delete a receipt
router.delete('/receipts/:id', removeReceipt);

router.get('/receipts/:id/image', fetchReceiptImage);

router.post('/receipts/:id/process', processReceiptManually);

router.get('/receipts/:id/items', fetchReceiptItems);

router.patch('/receipts/:id/items/:priceId', updateReceiptItem);

router.post('/receipts/:id/items', addReceiptItem);

export default router;