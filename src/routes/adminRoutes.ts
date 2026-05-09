import { Router } from 'express';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { deleteUserAccount } from '../controllers/adminController.js';

const router = Router();

router.delete('/admin/users/:id', requireAdmin, deleteUserAccount);

export default router;
