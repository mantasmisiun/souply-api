import { Router } from 'express';
import { addReceipt, fetchReceiptById, fetchReceiptsByUserId, updateReceiptOcrDetails, removeReceipt } from '../controllers/receiptController';

const router = Router();

// POST /api/receipts - Add a new receipt
router.post('/receipts', addReceipt);

// GET /api/users/:userId/receipts - Get all receipts for a user
router.get('/users/:userId/receipts', fetchReceiptsByUserId);

// GET /api/receipts/:id - Get a receipt by ID
router.get('/receipts/:id', fetchReceiptById);

// PATCH /api/receipts/:id/details - Update receipt OCR details
router.patch('/receipts/:id/details', updateReceiptOcrDetails);

// DELETE /api/receipts/:id - Delete a receipt
router.delete('/receipts/:id', removeReceipt);

export default router;